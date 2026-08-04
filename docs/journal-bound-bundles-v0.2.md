# Journal-bound evidence bundles v0.2

Status: local shadow-only integrity closure. No action, retry, wallet, signing, transaction-submission, or payment capability is present or enabled.

## Purpose

The v0.2 wrapper closes the gap between runtime-verified evidence and the legacy pure v0.1 evaluator. It accepts only a Base collection produced by the branded read-only collector and, when applicable, effect results produced by the branded Ed25519 verifier. It derives the legacy evaluator input itself, persists every input as immutable content-addressed data, and binds that exact input and result to two adjacent journal records.

The resulting evidence graph is one-way and has no circular hash:

```text
journaled attempt + branded Base/effect results
                    |
                    v
attempt / Base / effect / evaluator artifacts
                    |
                    v
            input-manifest artifact
                    |
                    v
       kernel_input_committed record
                    |
                    v
              bundle artifact
                    |
                    v
       kernel_bundle_committed record
                    |
                    v
       separate closure receipt
```

The closure receipt is returned separately and is never written into the bundle or journal. Its hash can therefore bind both journal commits without requiring a self-reference.

## Authority and time binding

- The Base audit artifact retains the exact authorization ID and requested transaction hash in hidden runtime context. A serialized collection or a collection created from an equivalent-but-different registry object is rejected.
- Each effect audit artifact retains the signed envelope, locally resolved query, registry/contract hashes, and the exact trusted `verifiedAt` used for signature and freshness checks. A serialized verified result is rejected.
- `operationStartedAt` comes from the unique `attempt_opened` journal record. An effect query with any other start time is rejected.
- `authorization_recorded` and `authorization_transmitted` are count-, authorization-ID-, order-, and time-bound between the attempt opening and evaluation. The remaining v0.1 attempt predicates (including preflight, policy, signing, and delivery assertions) are still caller-declared and explicitly labeled unverified in v0.2 assurance.
- `evaluatedAt` bounds Base collection time and effect verification time.
- Raw caller-supplied receipt, authorization-state, effect, or retry assertions cannot enter the v0.2 assembler. The evaluator observations are derived from the branded results, and v0.2 deliberately omits v0.1 retry assertions.

## Journal and artifact durability

Each journal has a random stable `journalId` in a canonical metadata sidecar. The ID is included in every record and record hash, so copying records under different metadata fails validation. Existing journal data without metadata, metadata without its journal, noncanonical records, torn writes, and hash-chain changes fail closed. While a writer is open, any external size change, truncation, or path replacement poisons that handle before another append. On restart, a rollback to an earlier fully valid journal prefix is indistinguishable from a legitimate shorter history unless a retained closure receipt or external checkpoint proves the later head.

Appends support a journal-ID-bound compare-and-set head and deterministic exact replay. The input and bundle commits must be globally adjacent; no operation or unrelated event may be inserted between them. The bundle commit closes that operation.

The artifact store writes private canonical JSON, fsyncs the temporary file, publishes it by same-filesystem hard link, requires a directory fsync, then removes the temporary name and requires another directory fsync. Reads recompute the content hash, enforce namespace and byte length, and reject symlinks, torn files, noncanonical encoding, and filename/hash disagreement.

The implementation assumes a local filesystem that supports atomic hard links and meaningful file and directory fsync. It is not a network-filesystem consensus protocol.

## Writer model and crash recovery

The journal uses an `O_EXCL` sentinel plus head compare-and-set for cooperating processes. This is deliberately not described as an OS advisory lock: a process killed before clean close leaves the sentinel behind. The implementation never guesses that a lock is stale from its PID, age, or mtime because doing so could create split-brain writers. An operator may remove a stale lock only after independently proving the writer is dead and retaining the journal for validation.

Crash outcomes are fail closed:

| Boundary | Durable state | Recovery behavior |
| --- | --- | --- |
| Before artifact publication | No commit | Retry from branded inputs |
| During artifact publication | Temporary or orphan artifact | Recovery audit reports `incomplete` or `invalid` |
| After artifacts, before input commit | Orphan artifacts | Recovery audit reports `incomplete` |
| After input commit, before bundle commit | Pending input at journal head | No interleaving is allowed; audit reports the exact pending sequence |
| After bundle artifact, before bundle commit | Pending input plus orphan bundle | Audit reports both |
| After bundle commit, before receipt delivery | Complete adjacent closure | `recoverJournalBoundClosureReceipt` regenerates and re-verifies the receipt |
| Uncertain same-process return | Deterministic records may already exist | Repeating the exact close call replays both anchors; conflicting content fails |
| Process death with open journal | Sentinel remains | Reopen fails until proven-dead manual recovery |

Recovery inspection is non-destructive. It never deletes temporary, orphan, corrupt, or unexpected files.

## What verification proves

`verifyJournalBoundBundleIntegrity` validates the retained closure receipt, complete journal pointers and adjacency, exact input-manifest source head, all artifact receipts and namespaces, operation and authorization identities, journaled attempt time, Base/evaluator linkage, effect audit linkage, deterministic v0.1 evaluation, v0.2 bundle hash, and the fixed no-action assurance object. It returns deeply frozen data and grants no runtime authority or execution brand. Reserved kernel commit kinds and their local writer are part of this integrity threat model; applications must not expose unrestricted journal append access as an authority API.

This is a local integrity replay, not a historical reauthentication of HTTPS transport and not an independent proof that an operator database was truthful. Offline verification does not reconstruct the process-local Base or effect authority brands. The runtime Base and effect checks are preserved as journal-bound artifacts, but offline signature re-verification still requires the separately pinned effect registry, and historical Base transport cannot be recreated from the artifact alone. The bundle therefore states all of the following explicitly:

- external truth proven: `false`;
- external anti-rollback checkpoint: `false`;
- operator database truth independently proven: `false`;
- offline effect signature re-verification: `false` (the bundle records runtime verification);
- trusted local writer required: `true`;
- non-lifecycle attempt predicates: `caller_declared_unverified`;
- payment, transaction, retry, and action execution enabled: `false`.

A local hash chain is tamper-evident relative to a retained receipt. It cannot prevent an attacker with full storage control from rolling back or replacing the journal, artifacts, and every retained receipt together. Production use requires an external WORM store, signed checkpoint, transparency log, or equivalent anti-rollback anchor.

## Verification

Run the deterministic journal, artifact, and bundle tests together with the repository gates:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

No command above authorizes a network request, transaction, payment, or retry.
