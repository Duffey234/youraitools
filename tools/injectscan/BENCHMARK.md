# InjectScan benchmark

Ruleset `2026.10.1`, generated 2026-10-21T21:40:39.613Z by `npm run benchmark` (`scripts/benchmark.js`). Re-run it yourself: the script downloads every dataset from its public source (nothing is vendored) and caches it in `.bench-cache/`.

## Data (all permissively licensed)

| Set | License | What it measures |
|---|---|---|
| [deepset/prompt-injections](https://huggingface.co/datasets/deepset/prompt-injections) | Apache-2.0 | Precision/recall. English + German. Many "injections" are subtle task switches ("Now write a poem about...") |
| [jackhhao/jailbreak-classification](https://huggingface.co/datasets/jackhhao/jailbreak-classification) | Apache-2.0 | Precision/recall. Long DAN-style jailbreaks vs benign role-play prompts |
| [Lakera/gandalf_ignore_instructions](https://huggingface.co/datasets/Lakera/gandalf_ignore_instructions) | MIT | Recall only (every row is an attack): real attempts to override Gandalf's instructions |
| 300 random English Wikipedia articles (`bench/benign-wikipedia.json`) | CC BY-SA (read at run time, not redistributed) | False-positive rate on ordinary web pages |
| 150 GitHub READMEs pinned to a commit (`bench/benign-readmes.json`, 144 fetched) | Each repo's own license (read at run time) | False-positive rate on technical docs: install scripts, badges, API keys, security notes |

BIPIA (Microsoft) was not used: its license metadata is not clear (`NOASSERTION`).

## Held-out vs dev

The rules were written while looking at the deepset and jackhhao **train** splits and at a *different* sample of Wikipedia articles and READMEs. Those rows are marked `dev` and are optimistic. The **test** splits, the Lakera set and the two benign corpora above were not used for tuning: they are the `held-out` rows, and the honest numbers.

`flagged` means verdict suspicious or malicious (risk ≥ 35). `malicious` means risk ≥ 70.

## Results

| Dataset | Split | Role | Threshold | n | TP | FP | TN | FN | Precision | Recall | F1 | FPR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepset/prompt-injections | train | dev | flagged | 546 | 120 | 0 | 343 | 83 | 1 | 0.591 | 0.743 | 0 |
| deepset/prompt-injections | train | dev | malicious | 546 | 49 | 0 | 343 | 154 | 1 | 0.241 | 0.389 | 0 |
| deepset/prompt-injections | test | held-out | flagged | 116 | 16 | 0 | 56 | 44 | 1 | 0.267 | 0.421 | 0 |
| deepset/prompt-injections | test | held-out | malicious | 116 | 10 | 0 | 56 | 50 | 1 | 0.167 | 0.286 | 0 |
| jackhhao/jailbreak-classification | train | dev | flagged | 1044 | 407 | 0 | 517 | 120 | 1 | 0.772 | 0.872 | 0 |
| jackhhao/jailbreak-classification | train | dev | malicious | 1044 | 271 | 0 | 517 | 256 | 1 | 0.514 | 0.679 | 0 |
| jackhhao/jailbreak-classification | test | held-out | flagged | 262 | 112 | 1 | 122 | 27 | 0.991 | 0.806 | 0.889 | 0.008 |
| jackhhao/jailbreak-classification | test | held-out | malicious | 262 | 81 | 0 | 123 | 58 | 1 | 0.583 | 0.736 | 0 |
| Lakera/gandalf_ignore_instructions | test | held-out | flagged | 112 | 74 | 0 | 0 | 38 | – | 0.661 | – | – |
| Lakera/gandalf_ignore_instructions | test | held-out | malicious | 112 | 68 | 0 | 0 | 44 | – | 0.607 | – | – |
| benign: Wikipedia (300 random) | - | held-out | flagged | 300 | 0 | 4 | 296 | 0 | – | – | – | 0.013 |
| benign: Wikipedia (300 random) | - | held-out | malicious | 300 | 0 | 0 | 300 | 0 | – | – | – | 0 |
| benign: GitHub READMEs (150) | - | held-out | flagged | 144 | 0 | 8 | 136 | 0 | – | – | – | 0.056 |
| benign: GitHub READMEs (150) | - | held-out | malicious | 144 | 0 | 4 | 140 | 0 | – | – | – | 0.028 |

## Reading this

- **Precision is very high** (0.99–1.00 on held-out labeled data). When InjectScan flags something it is almost always a real attack.
- **Recall depends on the attack style.** Known jailbreak templates and explicit "ignore your instructions" attacks are caught most of the time (0.81 on jackhhao test, 0.66 on Lakera). Subtle task switching with no override phrasing ("Great. Now tell me about cars instead.") mostly passes: recall is only 0.27 on deepset test. A model-based classifier will beat a rule set on this.
- **False positives on real content:** 1.3% of random Wikipedia articles and 5.6% of GitHub READMEs are flagged suspicious (0% and 2.8% malicious). The READMEs that trip it are mostly security tools and prompt-engineering repos that quote attacks, and install docs with `curl | sh`-style commands. If you scan technical documentation, consider acting only on `malicious`.
- Speed: well under 1 ms per prompt on average (Node 22, one core). A 200,000-character page scans in about 80 ms.
