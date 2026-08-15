use crate::config::{FetchConfig, ListSource};
use anyhow::{Result, anyhow};
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::Semaphore;

#[derive(Debug)]
pub struct FetchedList {
    pub text: String,
    pub bytes: usize,
    pub included_files: u64,
}

#[derive(Debug)]
pub struct SourceResult {
    pub source: ListSource,
    pub result: Result<FetchedList>,
}

pub struct Fetcher {
    client: reqwest::Client,
    semaphore: Arc<Semaphore>,
    cfg: FetchConfig,
    bytes_transferred: AtomicU64,
}

impl Fetcher {
    pub fn new(cfg: &FetchConfig) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(cfg.timeout_secs))
            .redirect(reqwest::redirect::Policy::limited(cfg.max_redirects))
            .user_agent(&cfg.user_agent)
            .build()?;
        Ok(Self {
            client,
            semaphore: Arc::new(Semaphore::new(cfg.concurrency.max(1))),
            cfg: cfg.clone(),
            bytes_transferred: AtomicU64::new(0),
        })
    }

    pub fn bytes_transferred(&self) -> u64 {
        self.bytes_transferred.load(Ordering::Relaxed)
    }

    pub async fn fetch_all(&self, lists: &[ListSource]) -> Vec<SourceResult> {
        let tasks = lists.iter().filter(|l| l.enabled).map(|list| async move {
            self.fetch_list(list).await
        });
        futures::future::join_all(tasks).await
    }

    async fn fetch_list(&self, list: &ListSource) -> SourceResult {
        let mut visited = HashSet::new();
        visited.insert(list.url.clone());
        let mut included_files = 0u64;

        let result = async {
            let root = self.fetch_with_retry(&list.url).await?;
            let text = if self.cfg.expand_includes {
                self.expand_includes(
                    root,
                    list.url.clone(),
                    0,
                    &mut visited,
                    &mut included_files,
                )
                .await?
            } else {
                root
            };
            let bytes = text.len();
            self.bytes_transferred
                .fetch_add(bytes as u64, Ordering::Relaxed);
            Ok(FetchedList {
                text,
                bytes,
                included_files,
            })
        }
        .await;

        SourceResult {
            source: list.clone(),
            result,
        }
    }

    async fn fetch_with_retry(&self, url: &str) -> Result<String> {
        let mut delay = self.cfg.retry_delay_ms;
        for attempt in 0..=self.cfg.retries {
            let permit = self.semaphore.acquire().await;
            let resp = self.client.get(url).send().await;
            drop(permit);

            match resp {
                Ok(r) if r.status().is_success() => {
                    let bytes = r.bytes().await?;
                    return Ok(String::from_utf8_lossy(&bytes).into_owned());
                }
                Ok(r) if r.status().is_server_error() && attempt < self.cfg.retries => {
                    tracing::warn!(url, status = %r.status(), attempt, "server error, retrying");
                }
                Ok(r) => {
                    return Err(anyhow!("HTTP {} for {url}", r.status()));
                }
                Err(e) if attempt < self.cfg.retries => {
                    tracing::warn!(url, error = %e, attempt, "transient network error, retrying");
                }
                Err(e) => {
                    return Err(anyhow!("network error for {url}: {e}"));
                }
            }

            tokio::time::sleep(Duration::from_millis(delay)).await;
            delay = delay.saturating_mul(2);
        }
        Err(anyhow!("request failed after {} retries", self.cfg.retries))
    }

    fn expand_includes<'a>(
        &'a self,
        text: String,
        source_url: String,
        depth: u32,
        visited: &'a mut HashSet<String>,
        included_files: &'a mut u64,
    ) -> futures::future::BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let mut out = String::with_capacity(text.len());
            for line in text.lines() {
                let trimmed = line.trim();
                let Some(raw_url) = parse_include_directive(trimmed) else {
                    out.push_str(line);
                    out.push('\n');
                    continue;
                };

                let include_url = match resolve_include_url(&source_url, &raw_url) {
                    Some(u) => u,
                    None => {
                        out.push_str("! StayBrave: could not resolve include ");
                        out.push_str(&raw_url);
                        out.push('\n');
                        continue;
                    }
                };

                if depth >= self.cfg.max_include_depth {
                    out.push_str("! StayBrave: include depth exceeded for ");
                    out.push_str(&include_url);
                    out.push('\n');
                    continue;
                }
                if !visited.insert(include_url.clone()) {
                    out.push_str("! StayBrave: include cycle detected for ");
                    out.push_str(&include_url);
                    out.push('\n');
                    continue;
                }

                match self.fetch_with_retry(&include_url).await {
                    Ok(included) => {
                        *included_files += 1;
                        let sub = self
                            .expand_includes(
                                included,
                                include_url.clone(),
                                depth + 1,
                                &mut *visited,
                                &mut *included_files,
                            )
                            .await?;
                        out.push_str(&sub);
                    }
                    Err(e) => {
                        tracing::warn!(url = %include_url, source = %source_url, "failed to expand include: {e:#}");
                        out.push_str("! StayBrave: failed to expand include ");
                        out.push_str(&include_url);
                        out.push('\n');
                    }
                }
            }
            Ok(out)
        })
    }
}

fn parse_include_directive(line: &str) -> Option<String> {
    let line = line.trim();
    let rest = line.strip_prefix("!#include")?;
    let url = rest.trim().trim_start_matches('<').trim_end_matches('>').trim();
    if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

fn resolve_include_url(source_url: &str, raw: &str) -> Option<String> {
    let base = url::Url::parse(source_url).ok()?;
    let resolved = base.join(raw).ok()?;
    if !matches!(resolved.scheme(), "http" | "https") {
        return None;
    }
    Some(resolved.to_string())
}
