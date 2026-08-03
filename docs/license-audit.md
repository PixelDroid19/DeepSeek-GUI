# Fork license audit

**Scope.** This is an engineering provenance record for this DeepSeek GUI fork,
captured on 2026-08-03. It is not legal advice.

## Recorded facts

- Fork head when this record was captured:
  `b0ad070737408413d573cebbae426dacf978a4be`.
- The last local commit explicitly labelled as an upstream merge is
  [`cb943c4b6512deadc1ce1cc1239bf374d292754f`](https://github.com/PixelDroid19/DeepSeek-GUI/commit/cb943c4b6512deadc1ce1cc1239bf374d292754f)
  (2026-06-10), whose subject is "Merge upstream/master from
  XingYu-Zhong/DeepSeek-GUI".
- The checked-in [`LICENSE`](../LICENSE) begins with `MIT License` and its
  copyright line is `Copyright (c) 2026 xingyu`.
- Its SHA-256 fingerprint is
  `1ab9c994b7859e0b5733814875a4798bdaa2f5a47a6a186c5049337f242cfcbc`; the
  boundary checker rejects a changed license file until the policy is reviewed.
- The canonical Kun upstream license is published at
  <https://raw.githubusercontent.com/KunAgent/Kun/master/LICENSE>. At the time
  of this audit it is PolyForm Noncommercial 1.0.0.
- Kun commit
  [`5472bed3b878854d296851820834145f5fe1a353`](https://github.com/KunAgent/Kun/commit/5472bed3b878854d296851820834145f5fe1a353),
  dated 2026-06-13 UTC, introduced that license change. It first appears in
  upstream release `v0.2.9`; this fork's MIT-era base is through `v0.2.8`.

## Practical boundary for this fork

The project decision is to keep this fork on its MIT-era `v0.2.8` base. The
source currently present in this fork is distributed under the checked-in MIT
text. The current upstream Kun license is PolyForm Noncommercial 1.0.0 and its
project notice restricts commercial use, commercial distribution, SaaS or
hosted-service use, resale, and commercial-product integration without a
separate written license.

Keeping this older fork under its checked-in MIT license is not permission to
copy code, files, or features from the post-change Kun upstream. Do not import
an upstream commit or file from
`5472bed3b878854d296851820834145f5fe1a353` (`v0.2.9`) or later without the
review required by [upstream-boundary.md](./upstream-boundary.md).

The boundary checker can reject undeclared exception markers and invalid
policy records, but it cannot identify arbitrary copied code from text alone.
Review every upstream-looking diff against the cutoff before merging it.

New, original changes made in this fork remain under the existing project
license unless the relevant copyright holder gives a different instruction.
Dependencies and vendored code retain their own licenses, copyright notices,
and attribution requirements.

This record documents source provenance and a practical engineering boundary;
it does not determine legal rights or replace advice from qualified counsel.
