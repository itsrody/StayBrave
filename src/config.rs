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
    #[serde(default)]
    pub filter: FilterConfig,
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
    /// Filter-list title shown by the adblock manager.
    #[serde(default = "default_output_title")]
    pub title: String,
    /// Short single-line description of what this list is and how it is built.
    #[serde(default = "default_output_description")]
    pub description: String,
    /// Suggested update frequency, in the form `N days` (or `N hours`), as
    /// understood by adblock managers (`! Expires:`).
    #[serde(default = "default_output_expires")]
    pub expires: String,
    #[serde(default = "default_output_homepage")]
    pub homepage: String,
}

impl Default for OutputConfig {
    fn default() -> Self {
        Self {
            file: default_output_file(),
            title: default_output_title(),
            description: default_output_description(),
            expires: default_output_expires(),
            homepage: default_output_homepage(),
        }
    }
}

/// Filters applied after parsing, to drop rules Brave's engine cannot use.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilterConfig {
    /// Remove uBO scriptlet-injection rules (`##+js(...)`, `#@#+js(...)`,
    /// `##script:inject(...)`). The adblock-rust engine parses these but cannot
    /// execute them, so in a browser they are dead rules.
    #[serde(default = "default_scriptlets_enabled")]
    pub scriptlets: bool,
    /// `$redirect`/`$redirect-rule`/`$rewrite` resources that staybrave
    /// considers supported. Rules referencing any other resource are dropped.
    /// Values must be canonical resource names; aliases are resolved to
    /// canonical names by the normalizer before they reach this list.
    #[serde(default = "default_redirect_allowlist")]
    pub redirect_allowlist: Vec<String>,
    /// Rewrite cosmetic rules into forms the procedural engine Brave ships
    /// actually executes: `:contains` -> `:has-text`, `:nth-ancestor` ->
    /// `:upward`, comma lists containing procedural/action operators are
    /// split, and rules built on operators that are dead in Brave (`:others`,
    /// `:matches-media`, `:-abp-properties`, `:matches-prop`, `:watch-attr`,
    /// empty `:remove-attr()`/`:remove-class()`/`:style()`) are dropped.
    #[serde(default = "default_cosmetic_compat")]
    pub cosmetic_compat: bool,
}

impl Default for FilterConfig {
    fn default() -> Self {
        Self {
            scriptlets: default_scriptlets_enabled(),
            redirect_allowlist: default_redirect_allowlist(),
            cosmetic_compat: default_cosmetic_compat(),
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
    /// Treat the list as hosts-file syntax: every `#`/`!` comment is dropped
    /// and IP-led / bare-domain lines are converted to `||domain^` rules.
    #[serde(default)]
    pub hosts: bool,
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

fn default_output_title() -> String {
    "StayBrave".into()
}

fn default_output_description() -> String {
    "StayBrave is a merged, de-duplicated, sorted filter list optimized for the adblock-rust engine Brave ships. It combines EasyList, uBlock Origin, AdGuard, Fanboy, and StevenBlack sources; removes scriptlet injections and $redirect resources the engine cannot execute; and rewrites cosmetic rules into forms Brave actually runs.".into()
}

fn default_output_expires() -> String {
    "3 days".into()
}

fn default_output_homepage() -> String {
    "https://github.com/itsrody/StayBrave".into()
}

fn default_scriptlets_enabled() -> bool {
    true
}

fn default_cosmetic_compat() -> bool {
    true
}

/// Canonical adblock-rust resource names (drawn from uBO's redirect-resources)
/// that match the set Brave's engine ships. Aliases such as `noopjs` are
/// canonicalized by the normalizer before the allowlist is consulted.
fn default_redirect_allowlist() -> Vec<String> {
    [
        "1x1.gif",
        "2x2.png",
        "3x2.png",
        "32x32.png",
        "empty",
        "noop.js",
        "noop.txt",
        "noop.html",
        "noop.css",
        "noop.json",
        "noop-1s.mp4",
        "noop-2s.mp4",
        "noop-3s.mp4",
        "noop-0.1s.mp3",
        "noop-0.5s.mp3",
        "noop-vast2.xml",
        "noop-vast3.xml",
        "noop-vast4.xml",
        "noop-vmap1.xml",
        "google-analytics_analytics.js",
        "googletagmanager_gtm.js",
        "googlesyndication_adsbygoogle.js",
        "googletagservices_gpt.js",
        "google-ima.js",
        "amazon_ads.js",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
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
