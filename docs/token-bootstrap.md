# Cloudflare token bootstrap

The optional bootstrap helper accepts one administrator token and uses the
existing official Cloudflare Terraform provider to create scoped deployment
credentials. Existing installations can continue supplying `CLOUDFLARE_API_TOKEN`
manually. This helper creates tokens only. The normal customer setup, Terraform
plan/apply, migrations and application deployment run afterward.

## Administrator credential

In Cloudflare **My Profile → API Tokens**, choose the **Create additional tokens**
template. It supplies **User → API Tokens → Edit**, which Cloudflare does not
expose in the custom token builder. Keep that token separate from the deployment
credentials. It needs no Worker, database, DNS or account-management grants of its
own. Cloudflare still checks the administrator's access to the selected account
and zones. This does not bypass a failed account permission check.

The alternative account-owned token API exists, but this implementation uses
user-owned tokens. An ordinary account deployment token or an account-token
management credential is not interchangeable with this user-token bootstrap.

Store the bootstrap value in a private file outside Git, with mode `0600`:

```dotenv
CLOUDFLARE_BOOTSTRAP_API_TOKEN=YOUR_TOKEN
```

Do not put it in the ordinary instance `.env`, command arguments or a Worker
secret. The helper only supplies it to Cloudflare token-management reads and
the isolated Terraform child process.

## CLI contract

Bun 1.4.4+ and Terraform 1.13.4+ are required. The bootstrap configuration is
[`roots/bootstrap`](../roots/bootstrap), pinned to the official
`cloudflare/cloudflare` provider **5.28.0** like the other roots; the helper
copies it into the private state directory and runs it there.

A non-secret configuration file contains:

```json
{
  "version": 1,
  "accountId": "0123456789abcdef0123456789abcdef",
  "webHost": "board.example.com",
  "apiHost": "api.example.com",
  "revision": "FULL_40_CHARACTER_SOURCE_COMMIT",
  "miniApps": true,
  "verifyDatabaseCertificate": true,
  "registerDatabaseCertificate": true
}
```

Optional fields: `"target": "gcp"` for Azad on Google Cloud, where Cloudflare
only serves DNS and TLS (the deployment token then gets Zone Read, DNS Write,
SSL and Certificates Write and Config Settings Write on the zones, and
`miniApps` and `verifyDatabaseCertificate` must be false); `"managedSource":
true` adds an Artifacts token (and, on Cloudflare, a Queues token for its push
events). Managed source can be added to a completed bootstrap later, never
removed.

`verifyDatabaseCertificate` requests account **SSL and Certificates Read** for
an existing Hyperdrive CA ID. Optional `registerDatabaseCertificate` defaults to
false; when true it requires verified database TLS and requests **Write** instead.
Choose it only with `AZAD_SELF_HOST_DATABASE_CA=neon-isrg-root-x1` in the normal
setup input. The later workload Terraform apply registers the OS-trusted public CA
and passes its ID to the installer. Bootstrap itself still only creates tokens.
The manual/existing-ID path stays Read-only. Mandatory channel binding remains
unsupported; CA registration never changes the selected database security policy.

```sh
bun --no-env-file scripts/bootstrap.ts plan \
  --config /private/bootstrap.json \
  --bootstrap-file /private/bootstrap.env \
  --state-dir ~/.azad/instances/default/cloudflare-bootstrap \
  --source ~/src/azad

bun --no-env-file scripts/bootstrap.ts apply \
  --config /private/bootstrap.json \
  --bootstrap-file /private/bootstrap.env \
  --state-dir ~/.azad/instances/default/cloudflare-bootstrap \
  --source ~/src/azad
```

`revision` must be the `HEAD` of the Azad source checkout the installation
deploys: `--source`, else `AZAD_SOURCE`, else the current directory. Nothing
of the app runs here; the revision only binds the receipt to that source.

`plan` is a **read-only bootstrap permission preview**, not a workload Terraform
plan. It reads the official permission catalog and checks required groups. It
cannot establish the zones or prove permission to mint every grant until apply.
Its JSON explicitly reports `zonesResolvedDuringApply: true`.

`apply` performs these steps:

1. Check the source/instance receipt and token inventory against retained state.
2. Create a temporary **Zone Read** token scoped to zones in the selected account.
3. Find the authoritative zone for each selected hostname in that account.
4. Create the deployment token and, if selected, a separate Mini Apps token.
   Delete the temporary discovery token through the same Terraform state.
5. Write the private credential handoff and completion receipt.

Every Terraform mutation uses a saved plan. The helper rejects an unexpected
resource, deletion of a retained deployment token, or recreation of a previously
saved token.

The deployment token has Account Settings Read, Workers Scripts Write, Workers R2
Storage Write, Queues Write, Hyperdrive Write and Pages Write on the selected
account. With verified database TLS selected, it also has Account: SSL and
Certificates Read, or Write when automatic CA registration is selected. Zone Read, DNS Write and Workers Routes Write apply only to
the discovered zones. Cloudflare's dashboard calls many API `Write` permissions
`Edit`. The helper resolves IDs from the official catalog and checks the resource
scope; it never grants token-management permissions to derived tokens.

The optional Mini Apps token has Workers Scripts Write and D1 Write on the same
account. It is separate from the deployment credential because the application
uses it at runtime. Other optional credentials, including managed Artifacts and
its event subscription token, keep their existing explicit configuration path.
The bootstrap does not guess those grants or create S3/state-bucket credentials.

## Result and handoff

Exit `0` means the requested operation succeeded. Exit `1` means failure; stderr
contains a sanitized diagnostic, not Cloudflare response bodies, Terraform logs
or secret values. Preserve the private directory on failure. A previous
`result.json` is not proof the current command succeeded.

Successful apply writes and prints this value-free JSON shape:

```json
{
  "version": 1,
  "accountId": "0123456789abcdef0123456789abcdef",
  "sourceRevision": "FULL_40_CHARACTER_CHECKOUT_COMMIT",
  "zoneIds": ["ZONE_ID"],
  "tokenIds": {"deployment": "TOKEN_ID", "miniapps": "TOKEN_ID"},
  "credentialsFile": "/private/installation/cloudflare-bootstrap/credentials.env"
}
```

`miniapps` is absent when disabled. `credentials.env` contains only
`CLOUDFLARE_API_TOKEN` and, when selected, `V3_CF_API_TOKEN` (and the managed
project source tokens when `managedSource` is selected). Merge it into the
instance's private `.env` (the `azad` installer does this), then run the
normal `cloudflare.ts` or `gcp.ts` `setup`/`init`/`plan`/`apply` sequence.
Bootstrap does not configure the application or claim installation success.

## State, retries and cleanup

Keep the entire bootstrap directory private (`0700`) and backed up securely. It
contains sensitive Terraform state and backups, plus `credentials.env` (`0600`).
Terraform's `sensitive` annotation hides normal output; it does not encrypt state.
This local administrator state is separate from the installation's own
Terraform state. Updates use the derived deployment token; they do not mint
tokens.

The receipt binds the account, hostnames, feature selection and source revision.
Retry the same command from that same source with the same files. A completed
retry retains the token identities and values, and verifies each credential itself
with Cloudflare before reuse or handoff. A token whose secret was rolled is refused
even when its ID and active status are unchanged. Missing state, a different
administrator's token inventory, revoked credentials, or source/target drift stops
before replacement. Importing token IDs cannot recover their secret values.
Restore the original directory and configuration rather than starting over.

If Cloudflare committed a token but Terraform did not retain its secret, the
helper detects the owned-name collision and stops. Recover the private state if
available. Otherwise explicitly revoke only the affected token in Cloudflare
using its recorded installation name/ID before restarting. Never delete or adopt
unrelated tokens. If a process was killed, remove `bootstrap.lock` only after
confirming its recorded process has ended; retain all other state.

A failure during zone lookup can leave the temporary read-only token. A successful
retry deletes it through its owned Terraform state. The helper never revokes the
administrator token or the final deployment/runtime tokens automatically. The
administrator may revoke the bootstrap credential after saving state and the
handoff; normal deployment and updates use only the derived credentials.

## References

- [Cloudflare token creation and resource policies](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)
- [Cloudflare permissions, dashboard and API names](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Official pinned Terraform token resource](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.28.0/docs/resources/api_token.md)
- [Account-owned token prerequisites](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
