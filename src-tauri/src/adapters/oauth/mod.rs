use crate::adapters::config::{OauthTokenConfig, Settings};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};

const OAUTH_CALLBACK_TIMEOUT_SECS: u64 = 300;
const OAUTH_EXPIRY_LEEWAY_SECS: i64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OauthStartResponse {
    pub provider: String,
    pub flow_id: String,
    pub authorize_url: String,
    pub redirect_uri: String,
    pub state: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OauthFinishResponse {
    pub provider: String,
    pub connected: bool,
    pub auth_mode: String,
    pub expires_at: Option<i64>,
    pub scope: Option<String>,
    pub token_type: Option<String>,
}

#[derive(Debug)]
struct PendingOauthFlow {
    provider: String,
    state: String,
    code_verifier: String,
    redirect_uri: String,
    receiver: oneshot::Receiver<CallbackPayload>,
    created_at: i64,
}

#[derive(Debug)]
struct CallbackPayload {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token: Option<String>,
    token_type: Option<String>,
    scope: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Clone)]
struct OAuthProviderConfig {
    authorize_url: &'static str,
    token_url: &'static str,
    scopes: &'static [&'static str],
    supports_pkce_plain: bool,
}

static PENDING_OAUTH_FLOWS: OnceLock<Mutex<HashMap<String, PendingOauthFlow>>> = OnceLock::new();

fn pending_oauth_flows() -> &'static Mutex<HashMap<String, PendingOauthFlow>> {
    PENDING_OAUTH_FLOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn provider_config(provider: &str) -> Option<OAuthProviderConfig> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "google" => Some(OAuthProviderConfig {
            authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            scopes: &["https://www.googleapis.com/auth/generative-language"],
            supports_pkce_plain: true,
        }),
        _ => None,
    }
}

fn oauth_client_env_key(provider: &str) -> Option<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "google" => Some("MELD_GOOGLE_OAUTH_CLIENT_ID"),
        _ => None,
    }
}

fn oauth_client_id(settings: &Settings, provider: &str) -> Option<String> {
    if let Some(client_id) = settings.oauth_client_id_for_provider(provider) {
        let trimmed = client_id.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    oauth_client_env_key(provider)
        .and_then(|key| std::env::var(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn build_authorize_url(
    provider: &str,
    config: &OAuthProviderConfig,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_verifier: &str,
) -> Result<String, String> {
    let mut url = reqwest::Url::parse(config.authorize_url).map_err(|e| e.to_string())?;
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("response_type", "code");
        qp.append_pair("client_id", client_id);
        qp.append_pair("redirect_uri", redirect_uri);
        qp.append_pair("scope", &config.scopes.join(" "));
        qp.append_pair("state", state);

        if config.supports_pkce_plain {
            qp.append_pair("code_challenge", code_verifier);
            qp.append_pair("code_challenge_method", "plain");
        }

        if provider == "google" {
            qp.append_pair("access_type", "offline");
            qp.append_pair("prompt", "consent");
        }
    }
    Ok(url.to_string())
}

async fn spawn_callback_listener(
    listener: TcpListener,
    sender: oneshot::Sender<CallbackPayload>,
) -> Result<(), String> {
    let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
    let mut buffer = [0_u8; 8192];
    let bytes_read = socket.read(&mut buffer).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_string();

    let callback_url = format!("http://127.0.0.1{path}");
    let parsed_url = reqwest::Url::parse(&callback_url).ok();

    let code = parsed_url
        .as_ref()
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "code")
                .map(|(_, value)| value.to_string())
        })
        .filter(|value| !value.trim().is_empty());
    let state = parsed_url.as_ref().and_then(|url| {
        url.query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.to_string())
    });
    let error = parsed_url.as_ref().and_then(|url| {
        url.query_pairs()
            .find(|(key, _)| key == "error")
            .map(|(_, value)| value.to_string())
    });
    let error_description = parsed_url.as_ref().and_then(|url| {
        url.query_pairs()
            .find(|(key, _)| key == "error_description")
            .map(|(_, value)| value.to_string())
    });

    let success = code.is_some() && error.is_none();
    let body = if success {
        "<html><body><h3>meld OAuth complete</h3><p>You can return to the app.</p></body></html>"
    } else {
        "<html><body><h3>meld OAuth failed</h3><p>Return to the app and check the error.</p></body></html>"
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.flush().await;

    let _ = sender.send(CallbackPayload {
        code,
        state,
        error,
        error_description,
    });

    Ok(())
}

async fn exchange_code_for_token(
    provider: &str,
    config: &OAuthProviderConfig,
    client_id: &str,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Result<OauthTokenConfig, String> {
    let client = reqwest::Client::new();
    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("client_id", client_id.to_string()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
    ];
    if config.supports_pkce_plain {
        form.push(("code_verifier", code_verifier.to_string()));
    }

    let response = client
        .post(config.token_url)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    let parsed: TokenResponse = serde_json::from_str(&body).unwrap_or(TokenResponse {
        access_token: None,
        expires_in: None,
        refresh_token: None,
        token_type: None,
        scope: None,
        error: Some(format!("unparsed_{provider}_token_response")),
        error_description: Some(body.clone()),
    });

    if !status.is_success() || parsed.error.is_some() {
        let message = parsed
            .error_description
            .or(parsed.error)
            .unwrap_or_else(|| format!("OAuth token exchange failed with status {status}"));
        return Err(message);
    }

    let access_token = parsed
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "OAuth provider did not return access_token".to_string())?;

    let expires_at = parsed
        .expires_in
        .map(|expires_in| Utc::now().timestamp() + expires_in);
    Ok(OauthTokenConfig {
        access_token,
        refresh_token: parsed.refresh_token,
        token_type: parsed.token_type,
        scope: parsed.scope,
        expires_at,
    })
}

async fn refresh_token_if_needed(
    provider: &str,
    settings: &mut Settings,
    token: OauthTokenConfig,
) -> Result<OauthTokenConfig, String> {
    let now = Utc::now().timestamp();
    let needs_refresh = token
        .expires_at
        .map(|expires_at| expires_at <= now + OAUTH_EXPIRY_LEEWAY_SECS)
        .unwrap_or(false);

    if !needs_refresh {
        return Ok(token);
    }

    let config = provider_config(provider)
        .ok_or_else(|| format!("OAuth is not supported for provider '{provider}'"))?;
    let refresh_token = token
        .refresh_token
        .clone()
        .ok_or_else(|| format!("OAuth token for provider '{provider}' has no refresh token"))?;
    let client_id = oauth_client_id(settings, provider).ok_or_else(|| {
        format!(
            "OAuth client_id is missing for provider '{}'. Configure it in Settings or env.",
            provider
        )
    })?;

    let client = reqwest::Client::new();
    let form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("client_id", client_id),
        ("refresh_token", refresh_token.clone()),
    ];

    let response = client
        .post(config.token_url)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    let parsed: TokenResponse = serde_json::from_str(&body).unwrap_or(TokenResponse {
        access_token: None,
        expires_in: None,
        refresh_token: None,
        token_type: None,
        scope: None,
        error: Some(format!("unparsed_{provider}_refresh_response")),
        error_description: Some(body.clone()),
    });

    if !status.is_success() || parsed.error.is_some() {
        return Err(parsed
            .error_description
            .or(parsed.error)
            .unwrap_or_else(|| format!("OAuth refresh failed with status {status}")));
    }

    let access_token = parsed
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "OAuth refresh did not return access_token".to_string())?;
    let expires_at = parsed
        .expires_in
        .map(|expires_in| Utc::now().timestamp() + expires_in);

    Ok(OauthTokenConfig {
        access_token,
        refresh_token: parsed.refresh_token.or(Some(refresh_token)),
        token_type: parsed.token_type.or(token.token_type),
        scope: parsed.scope.or(token.scope),
        expires_at,
    })
}

pub async fn start_oauth(provider: &str) -> Result<OauthStartResponse, String> {
    let provider = provider.trim().to_ascii_lowercase();
    let config = provider_config(&provider)
        .ok_or_else(|| format!("OAuth is not supported for provider '{provider}'"))?;

    let settings = Settings::load_global();
    let client_id = oauth_client_id(&settings, &provider).ok_or_else(|| {
        format!(
            "OAuth client_id is missing for provider '{}'. Set it in Settings first.",
            provider
        )
    })?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let local_addr = listener.local_addr().map_err(|e| e.to_string())?;
    let redirect_uri = format!("http://127.0.0.1:{}/oauth/callback", local_addr.port());
    let flow_id = uuid::Uuid::new_v4().to_string();
    let state = uuid::Uuid::new_v4().to_string();
    let code_verifier = uuid::Uuid::new_v4().to_string().replace('-', "");

    let authorize_url = build_authorize_url(
        &provider,
        &config,
        &client_id,
        &redirect_uri,
        &state,
        &code_verifier,
    )?;

    let (sender, receiver) = oneshot::channel::<CallbackPayload>();
    tokio::spawn(async move {
        let _ = spawn_callback_listener(listener, sender).await;
    });

    let mut flows = pending_oauth_flows().lock().await;
    let now = Utc::now().timestamp();
    flows.retain(|_, flow| now - flow.created_at <= OAUTH_CALLBACK_TIMEOUT_SECS as i64);
    flows.insert(
        flow_id.clone(),
        PendingOauthFlow {
            provider: provider.clone(),
            state: state.clone(),
            code_verifier,
            redirect_uri: redirect_uri.clone(),
            receiver,
            created_at: now,
        },
    );
    drop(flows);

    Ok(OauthStartResponse {
        provider,
        flow_id,
        authorize_url,
        redirect_uri,
        state,
        timeout_ms: OAUTH_CALLBACK_TIMEOUT_SECS * 1000,
    })
}

pub async fn finish_oauth(
    provider: &str,
    flow_id: &str,
    timeout_ms: Option<u64>,
) -> Result<OauthFinishResponse, String> {
    let provider = provider.trim().to_ascii_lowercase();
    let config = provider_config(&provider)
        .ok_or_else(|| format!("OAuth is not supported for provider '{provider}'"))?;

    let mut flows = pending_oauth_flows().lock().await;
    let pending = flows
        .remove(flow_id)
        .ok_or_else(|| format!("OAuth flow '{}' not found or already consumed", flow_id))?;
    drop(flows);

    if pending.provider != provider {
        return Err(format!(
            "OAuth flow provider mismatch: expected '{}', got '{}'",
            pending.provider, provider
        ));
    }

    let wait_ms = timeout_ms
        .unwrap_or(OAUTH_CALLBACK_TIMEOUT_SECS * 1000)
        .max(1000);
    let callback_payload = timeout(Duration::from_millis(wait_ms), pending.receiver)
        .await
        .map_err(|_| "Timed out waiting for OAuth callback".to_string())?
        .map_err(|_| "OAuth callback channel closed unexpectedly".to_string())?;

    if let Some(error) = callback_payload.error {
        let detail = callback_payload.error_description.unwrap_or_default();
        return Err(format!("OAuth callback error: {} {}", error, detail));
    }

    let code = callback_payload
        .code
        .ok_or_else(|| "OAuth callback did not include authorization code".to_string())?;
    let callback_state = callback_payload.state.unwrap_or_default();
    if callback_state != pending.state {
        return Err("OAuth callback state mismatch".to_string());
    }

    let mut settings = Settings::load_global();
    let client_id = oauth_client_id(&settings, &provider).ok_or_else(|| {
        format!(
            "OAuth client_id is missing for provider '{}'. Configure it in Settings first.",
            provider
        )
    })?;
    let token = exchange_code_for_token(
        &provider,
        &config,
        &client_id,
        &code,
        &pending.redirect_uri,
        &pending.code_verifier,
    )
    .await?;

    settings.upsert_oauth_token(&provider, token.clone());
    settings
        .set_auth_mode(&provider, "oauth")
        .map_err(|e| e.to_string())?;
    settings.save().map_err(|e| e.to_string())?;

    Ok(OauthFinishResponse {
        provider,
        connected: true,
        auth_mode: "oauth".to_string(),
        expires_at: token.expires_at,
        scope: token.scope,
        token_type: token.token_type,
    })
}

pub fn disconnect_oauth(provider: &str) -> Result<(), String> {
    let provider = provider.trim().to_ascii_lowercase();
    let mut settings = Settings::load_global();
    settings.clear_oauth_connection(&provider);
    settings.save().map_err(|e| e.to_string())
}

pub async fn resolve_provider_credential(
    settings: &mut Settings,
    provider: &str,
) -> Result<String, String> {
    let provider = provider.trim().to_ascii_lowercase();
    let auth_mode = settings.auth_mode_for_provider(&provider);

    if auth_mode == "oauth" {
        let token = settings
            .oauth_token_for_provider(&provider)
            .ok_or_else(|| {
                format!(
                    "OAuth is selected for provider '{}' but no OAuth token is connected",
                    provider
                )
            })?;
        let refreshed = refresh_token_if_needed(&provider, settings, token).await?;
        settings.upsert_oauth_token(&provider, refreshed.clone());
        settings.save().map_err(|e| e.to_string())?;
        return Ok(refreshed.access_token);
    }

    settings.api_key_for_provider(&provider).ok_or_else(|| {
        format!(
            "No API key configured for provider '{}'. Add one in Settings or switch to OAuth.",
            provider
        )
    })
}

#[cfg(test)]
mod tests {
    use super::provider_config;

    #[test]
    fn provider_config_supports_google() {
        let google = provider_config("google").expect("google oauth config");
        assert!(google.authorize_url.contains("accounts.google.com"));
        assert!(google.token_url.contains("oauth2.googleapis.com"));
    }

    #[test]
    fn provider_config_rejects_unknown_provider() {
        assert!(provider_config("anthropic").is_none());
    }
}
