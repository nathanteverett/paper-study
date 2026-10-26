//! Paper discovery through Semantic Scholar and arXiv, and PDF download.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const USER_AGENT: &str = "PaperStudy/0.1 (desktop research reader)";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchResult {
    pub source: String,
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    pub venue: Option<String>,
    pub url: Option<String>,
    pub pdf_url: Option<String>,
    pub citation_count: Option<i64>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

pub async fn semantic_scholar(query: &str, api_key: &str) -> Result<Vec<SearchResult>, String> {
    let url = format!(
        "https://api.semanticscholar.org/graph/v1/paper/search?query={}&limit=20&fields=title,authors,year,abstract,venue,externalIds,openAccessPdf,citationCount,url",
        urlencoding::encode(query)
    );
    let key = Some(api_key.trim().to_string())
        .filter(|k| !k.is_empty())
        .or_else(|| std::env::var("SEMANTIC_SCHOLAR_API_KEY").ok());
    let client = client()?;
    // Without a key, requests share a public pool that often answers 429; back off and retry.
    let mut attempt = 0;
    let resp = loop {
        let mut req = client.get(&url);
        if let Some(k) = &key {
            req = req.header("x-api-key", k);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        if resp.status().as_u16() != 429 || attempt == 3 {
            break resp;
        }
        attempt += 1;
        tokio::time::sleep(std::time::Duration::from_millis(1200 * attempt)).await;
    };
    if resp.status().as_u16() == 429 {
        return Err("Semantic Scholar's free tier is busy. Try again in a moment, search arXiv instead, or add a free Semantic Scholar API key in Settings.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Semantic Scholar returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let items = body["data"].as_array().cloned().unwrap_or_default();
    Ok(items
        .iter()
        .map(|p| {
            let arxiv = p["externalIds"]["ArXiv"].as_str().map(str::to_string);
            let pdf_url = p["openAccessPdf"]["url"]
                .as_str()
                .filter(|u| !u.is_empty())
                .map(str::to_string)
                .or_else(|| arxiv.as_ref().map(|a| format!("https://arxiv.org/pdf/{a}")));
            SearchResult {
                source: "semanticscholar".into(),
                id: p["paperId"].as_str().unwrap_or_default().to_string(),
                title: p["title"].as_str().unwrap_or("Untitled").to_string(),
                authors: p["authors"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x["name"].as_str().map(str::to_string)).collect())
                    .unwrap_or_default(),
                year: p["year"].as_i64().map(|y| y as i32),
                abstract_text: p["abstract"].as_str().map(str::to_string),
                venue: p["venue"].as_str().filter(|v| !v.is_empty()).map(str::to_string),
                url: p["url"].as_str().map(str::to_string),
                pdf_url,
                citation_count: p["citationCount"].as_i64(),
            }
        })
        .collect())
}

pub async fn arxiv(query: &str) -> Result<Vec<SearchResult>, String> {
    let url = format!(
        "https://export.arxiv.org/api/query?search_query=all:{}&start=0&max_results=20&sortBy=relevance",
        urlencoding::encode(query)
    );
    let resp = client()?.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("arXiv returned {}", resp.status()));
    }
    let xml = resp.text().await.map_err(|e| e.to_string())?;
    let doc = roxmltree::Document::parse(&xml).map_err(|e| e.to_string())?;
    let child_text = |node: roxmltree::Node, name: &str| {
        node.children()
            .find(|c| c.tag_name().name() == name)
            .and_then(|c| c.text())
            .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
    };
    Ok(doc
        .descendants()
        .filter(|n| n.tag_name().name() == "entry")
        .map(|entry| {
            let abs_url = child_text(entry, "id").unwrap_or_default();
            // http://arxiv.org/abs/2401.01234v2 -> 2401.01234
            let arxiv_id = abs_url
                .rsplit("/abs/")
                .next()
                .unwrap_or_default()
                .split('v')
                .next()
                .unwrap_or_default()
                .to_string();
            let pdf_url = entry
                .children()
                .find(|c| c.tag_name().name() == "link" && c.attribute("title") == Some("pdf"))
                .and_then(|c| c.attribute("href"))
                .map(|h| h.replace("http://", "https://"));
            SearchResult {
                source: "arxiv".into(),
                id: arxiv_id,
                title: child_text(entry, "title").unwrap_or_else(|| "Untitled".into()),
                authors: entry
                    .children()
                    .filter(|c| c.tag_name().name() == "author")
                    .filter_map(|a| child_text(a, "name"))
                    .collect(),
                year: child_text(entry, "published").and_then(|d| d.get(..4).and_then(|y| y.parse().ok())),
                abstract_text: child_text(entry, "summary"),
                venue: Some("arXiv".into()),
                url: Some(abs_url.replace("http://", "https://")),
                pdf_url,
                citation_count: None,
            }
        })
        .collect())
}

/// Downloads a PDF, refusing anything that isn't one (paywalls, HTML landing pages).
pub async fn download_pdf(url: &str) -> Result<Vec<u8>, String> {
    let resp = client()?.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("PDF download returned {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"%PDF") {
        return Err("The link did not return a PDF (it may be behind a paywall).".into());
    }
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    // Live network calls: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn arxiv_search_parses_entries() {
        let r = super::arxiv("attention is all you need").await.unwrap();
        assert!(!r.is_empty());
        assert!(r.iter().all(|p| !p.title.is_empty() && p.pdf_url.is_some()));
    }

    #[tokio::test]
    #[ignore]
    async fn semantic_scholar_search_parses_entries() {
        let r = super::semantic_scholar("attention is all you need", "").await.unwrap();
        assert!(!r.is_empty());
        assert!(r[0].year.is_some());
    }
}
