# Upstream license boundary

This policy preserves the decision to keep this fork on its MIT-era Kun
`v0.2.8` base. It prevents accidental reuse of upstream material whose
licensing changed in `v0.2.9`. It is an engineering control and provenance
record, not legal advice.

## Machine-readable cutoff

UPSTREAM_LICENSE_CUTOFF: 5472bed3b878854d296851820834145f5fe1a353
UPSTREAM_LICENSE_CUTOFF_DATE: 2026-06-13
UPSTREAM_LICENSE_CUTOFF_RELEASE: v0.2.9
UPSTREAM_LICENSE_SOURCE: https://github.com/KunAgent/Kun

The cutoff commit itself is on the restricted side of this boundary. Its parent
is the last known pre-change point; an upstream commit that is the cutoff or a
descendant of it must not be imported until an explicit license decision has
been made.

## Required review before an upstream import

1. Record the candidate's full Kun upstream commit SHA, source URL, and exact
   files or patches proposed for import.
2. Verify ancestry against `UPSTREAM_LICENSE_CUTOFF`. For a local clone of the
   canonical upstream, `git merge-base --is-ancestor
   5472bed3b878854d296851820834145f5fe1a353 <candidate-sha>` returning success
   means the candidate is the cutoff or a descendant and is therefore on the
   restricted side.
3. If the candidate is on the restricted side, or ancestry cannot be
   established, stop the cherry-pick, copy, or vendoring operation. Obtain and
   record an explicit license decision before importing any affected file.
4. Preserve the source commit, decision record, copyright notices, and any
   dependency or vendored-code obligations with the import review.

The checked-in MIT `LICENSE` remains authoritative for the source already in
this fork. It does not grant permission to import later upstream code.

## Exception guard

There are no approved upstream-import exceptions. The focused checker scans
tracked files for its upstream-license exception marker and rejects each marker
unless this document contains a matching approval record. A record may be
added only after an explicit license decision and must use this exact format:

```text
APPROVED_UPSTREAM_IMPORT: <repository-relative-path> | decision=<decision-record-id> | reviewed=<YYYY-MM-DD>
```

The path names the file containing the marker. The decision identifier must
refer to the documented license decision, and the review date records when the
approval was made. Removing an approval record does not authorize an import;
it causes the checker to reject the marker again.
