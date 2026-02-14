#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalEvalDataset {
    pub name: String,
    #[serde(default)]
    pub cases: Vec<RetrievalEvalCase>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalEvalCase {
    pub id: String,
    pub query: String,
    #[serde(default)]
    pub expected_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalEvalReport {
    pub dataset: String,
    pub cases: usize,
    pub k: usize,
    pub recall_at_k: f64,
    pub mrr_at_k: f64,
}

pub fn load_dataset(path: &Path) -> Result<RetrievalEvalDataset, Box<dyn std::error::Error>> {
    let raw = std::fs::read_to_string(path)?;
    let dataset = serde_yaml_ng::from_str::<RetrievalEvalDataset>(&raw)?;
    Ok(dataset)
}

pub fn evaluate_predictions(
    dataset: &RetrievalEvalDataset,
    predictions: &HashMap<String, Vec<String>>,
    k: usize,
) -> RetrievalEvalReport {
    let k = k.max(1);
    let mut recall_sum = 0.0_f64;
    let mut mrr_sum = 0.0_f64;

    for case in &dataset.cases {
        let predicted = predictions
            .get(&case.id)
            .map(|values| values.iter().take(k).cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        recall_sum += recall_at_k(&case.expected_paths, &predicted);
        mrr_sum += mrr_at_k(&case.expected_paths, &predicted);
    }

    let case_count = dataset.cases.len();
    let divisor = if case_count == 0 {
        1.0
    } else {
        case_count as f64
    };

    RetrievalEvalReport {
        dataset: dataset.name.clone(),
        cases: case_count,
        k,
        recall_at_k: recall_sum / divisor,
        mrr_at_k: mrr_sum / divisor,
    }
}

pub fn recall_at_k(expected_paths: &[String], predicted_paths: &[String]) -> f64 {
    if expected_paths.is_empty() {
        return 0.0;
    }
    if expected_paths.iter().any(|expected| {
        predicted_paths
            .iter()
            .any(|predicted| predicted == expected)
    }) {
        1.0
    } else {
        0.0
    }
}

pub fn mrr_at_k(expected_paths: &[String], predicted_paths: &[String]) -> f64 {
    for (index, candidate) in predicted_paths.iter().enumerate() {
        if expected_paths.iter().any(|expected| expected == candidate) {
            return 1.0 / (index as f64 + 1.0);
        }
    }
    0.0
}

#[cfg(test)]
mod tests {
    use super::{evaluate_predictions, load_dataset, RetrievalEvalDataset};
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn dataset_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("retrieval_eval")
            .join("dataset.yaml")
    }

    #[test]
    fn load_eval_dataset_from_yaml() {
        let dataset = load_dataset(&dataset_path()).expect("load dataset");
        assert_eq!(dataset.name, "kb-retrieval-core");
        assert!(!dataset.cases.is_empty());
    }

    #[test]
    fn evaluate_predictions_reports_metrics() {
        let dataset = RetrievalEvalDataset {
            name: "demo".to_string(),
            cases: vec![
                super::RetrievalEvalCase {
                    id: "c1".to_string(),
                    query: "query".to_string(),
                    expected_paths: vec!["a.md".to_string()],
                },
                super::RetrievalEvalCase {
                    id: "c2".to_string(),
                    query: "query".to_string(),
                    expected_paths: vec!["z.md".to_string()],
                },
            ],
        };

        let predictions = HashMap::from([
            (
                "c1".to_string(),
                vec!["a.md".to_string(), "b.md".to_string()],
            ),
            (
                "c2".to_string(),
                vec!["x.md".to_string(), "z.md".to_string()],
            ),
        ]);
        let report = evaluate_predictions(&dataset, &predictions, 5);
        assert_eq!(report.cases, 2);
        assert!((report.recall_at_k - 1.0).abs() < 1e-9);
        assert!((report.mrr_at_k - 0.75).abs() < 1e-9);
    }
}
