use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub fetch: FetchConfig,
    #[serde(default)]
    pub output: OutputConfig,
    pub lists: Vec<ListSource>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FetchConfig {
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    #[serde(default = "default_retries")]
    pub retries: u32,
    #[serde(default = "default_retry_delay_ms")]
    pub retry_delay_ms: u64,
    #[serde(default = "default_max_redirects")]
    pub max_redirects: usize,
    #[serde(default = "default_expand_includes")]
    pub expand_includes: bool,
    #[serde(default = "default_max_include_depth")]
    pub max_include_depth: u32,
    #[serde(default = "default_user_agent")]
    pub user_agent: String,
}

impl Default for FetchConfig {
    fn default() -> Self {
        Self {
            concurrency: default_concurrency(),
            timeout_secs: default_timeout_secs(),
            retries: default_retries(),
            retry_delay_ms: default_retry_delay_ms(),
            max_redirects: default_max_redirects(),
            expand_includes: default_expand_includes(),
            max_include_depth: default_max_include_depth(),
            user_agent: default_user_agent(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputConfig {
    #[serde(default = "default_output_file")]
    pub file: String,
}

impl Default for OutputConfig {
    fn default() -> Self {
        Self {
            file: default_output_file(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListSource {
    pub name: String,
    pub url: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_concurrency() -> usize {
    16
}

fn default_timeout_secs() -> u64 {
    30
}

fn default_retries() -> u32 {
    2
}

fn default_retry_delay_ms() -> u64 {
    500
}

fn default_max_redirects() -> usize {
    5
}

fn default_expand_includes() -> bool {
    true
}

fn default_max_include_depth() -> u32 {
    4
}

fn default_user_agent() -> String {
    "StayBrave/0.1 (filter-list optimizer)".into()
}

fn default_output_file() -> String {
    "StayBrave.txt".into()
}

fn default_enabled() -> bool {
    true
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading config {}", path.display()))?;
        let cfg: Config =
            toml::from_str(&raw).with_context(|| format!("parsing config {}", path.display()))?;
        Ok(cfg)
    }
}
