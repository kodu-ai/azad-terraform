import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  changingPhase,
  instanceTerraform,
  terraformArguments,
} from "./instance"
import {
  assertMoved,
  backendConfig,
  backendEnvironment,
  cloudflarePrefix,
  cloudflareStore,
  configureBackend,
  gcpStore,
  moveLocalState,
  withOperation,
  type TerraformRun,
} from "./state"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function instance(root: "postgres" | "gcp-celld" = "postgres") {
  const directory = mkdtempSync(join(tmpdir(), "azad-terraform-state-"))
  directories.push(directory)
  const files = instanceTerraform(join(directory, "instance"), root)
  mkdirSync(files.directory, { recursive: true })
  return files
}

const account = "0123456789abcdef0123456789abcdef"

test("the Cloudflare bucket carries the installer's resource prefix", () => {
  // modules/cloudflare/resources and the app name api.board.example.com's resources so.
  expect(cloudflarePrefix("https://api.board.example.com")).toBe(
    "azad-api-board-example-com-7ec551c7"
  )
  expect(cloudflareStore(account, "https://api.board.example.com")).toEqual({
    kind: "r2",
    bucket: "azad-api-board-example-com-7ec551c7-install",
    account_id: account,
  })
  expect(gcpStore("azad-board-1a2b", "customer-project").bucket).toMatch(
    /^azad-board-1a2b-[a-f0-9]{8}-install$/u
  )
})

test("each root's state gets its own key, with R2's create-only lock", () => {
  const r2 = backendConfig(
    cloudflareStore(account, "https://api.a.example"),
    "cloudsql"
  )
  expect(r2).toContain('key = "terraform/cloudsql.tfstate"')
  expect(r2).toContain(
    `endpoints = { s3 = "https://${account}.r2.cloudflarestorage.com" }`
  )
  expect(r2).toContain("use_lockfile = true")
  expect(
    backendConfig(gcpStore("azad-a-1", "p-project"), "gcp-celld")
  ).toContain('prefix = "terraform/gcp-celld"')
  const files = instance()
  expect(terraformArguments("init", ["-input=false"], files)).toEqual([
    "-reconfigure",
    `-backend-config=${files.backend}`,
    "-input=false",
  ])
})

test("init creates the R2 bucket once and records the token's id for R2's credentials", async () => {
  const files = instance()
  const store = cloudflareStore(account, "https://api.board.example.com")
  const requests: string[] = []
  let attempts = 0
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    requests.push(`${init?.method ?? "GET"} ${path}`)
    if (path.endsWith("/r2/buckets")) {
      attempts += 1
      // Cloudflare's transient internal error, then "you already own it".
      return Response.json({
        success: false,
        errors: [{ code: attempts === 1 ? 10001 : 10004 }],
      })
    }
    if (path === `/client/v4/accounts/${account}/tokens/verify`)
      return Response.json({ success: true, result: { id: "token-id" } })
    return Response.json({ success: false }, { status: 404 })
  }
  const record = await configureBackend(files, store, {
    token: "secret-token",
    fetcher,
  })
  expect(requests).toEqual([
    `POST /client/v4/accounts/${account}/r2/buckets`,
    `POST /client/v4/accounts/${account}/r2/buckets`,
    `GET /client/v4/accounts/${account}/tokens/verify`,
  ])
  expect(readFileSync(files.backend, "utf8")).toBe(
    backendConfig(store, "postgres")
  )
  expect(JSON.parse(readFileSync(files.backendRecord, "utf8"))).toEqual(record)
  expect(backendEnvironment(record, "secret-token", "init")).toEqual({
    AWS_ACCESS_KEY_ID: "token-id",
    AWS_SECRET_ACCESS_KEY: createHash("sha256")
      .update("secret-token")
      .digest("hex"),
  })
  // The token's secret never lands on disk, and a rotated token needs init again.
  expect(readFileSync(files.backendRecord, "utf8")).not.toContain(
    "secret-token"
  )
  expect(() =>
    backendEnvironment(record, "rotated-token", "the init command")
  ).toThrow("the init command")
})

test("init creates a private, versioned GCS bucket in the installation's region", async () => {
  const files = instance("gcp-celld")
  const store = gcpStore("azad-board-1a2b", "customer-project")
  let body: unknown
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    expect(String(url)).toBe(
      "https://storage.googleapis.com/storage/v1/b?project=customer-project"
    )
    return Response.json({})
  }
  await configureBackend(files, store, {
    token: "cloudflare-token",
    location: "me-central2",
    fetcher,
    googleToken: () => "google-token",
  })
  expect(body).toMatchObject({
    name: store.bucket,
    location: "me-central2",
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true },
      publicAccessPrevention: "enforced",
    },
    versioning: { enabled: true },
  })
  // A bucket name someone else holds is refused.
  const taken = async (url: string | URL | Request) =>
    String(url).includes("?project=")
      ? new Response("", { status: 409 })
      : new Response("", { status: 403 })
  await expect(
    configureBackend(files, store, {
      token: "t",
      fetcher: taken,
      googleToken: () => "google-token",
    })
  ).rejects.toThrow("taken by another project")
})

/** A remote backend `terraform state pull/push` talk to. */
function remoteBackend(initial?: object) {
  // An empty backend answers `state pull` with an empty state, as R2 does.
  let remote = JSON.stringify(
    initial ?? { version: 4, serial: 0, lineage: "", resources: [] }
  )
  const run: TerraformRun = (args) => {
    if (args[0] === "state" && args[1] === "pull")
      return { status: 0, stdout: remote }
    if (args[0] === "state" && args[1] === "push") {
      remote = readFileSync(args.at(-1) ?? "", "utf8")
      return { status: 0, stdout: "" }
    }
    return { status: 1, stdout: "" }
  }
  return { run, remote: () => remote }
}
const localState = {
  version: 4,
  serial: 7,
  lineage: "lineage-a",
  resources: [{ type: "x" }],
}

test("init moves an existing local state into the bucket and keeps a copy", () => {
  const files = instance()
  writeFileSync(files.state, JSON.stringify(localState))
  writeFileSync(
    `${files.state}.backup`,
    JSON.stringify({ ...localState, serial: 6 })
  )
  const backend = remoteBackend()
  const kept = moveLocalState(
    files,
    backend.run,
    new Date("2026-11-05T00:00:00Z")
  )
  expect(JSON.parse(backend.remote())).toEqual(localState)
  expect(kept).toBe(`${files.state}.before-remote-2026-11-05T00-00-00-000Z`)
  expect(JSON.parse(readFileSync(kept ?? "", "utf8"))).toEqual(localState)
  // Nothing is left where a release before 0.1.0 would read it.
  expect(existsSync(files.state)).toBe(false)
  expect(existsSync(`${files.state}.backup`)).toBe(false)
  // A second init has nothing to move.
  expect(moveLocalState(files, backend.run)).toBeUndefined()
})

test("an interrupted move finishes; another installation's state is never overwritten", () => {
  const moved = instance()
  writeFileSync(moved.state, JSON.stringify(localState))
  // Terraform gives a moved state a new lineage; its contents are what count.
  expect(
    moveLocalState(
      moved,
      remoteBackend({ ...localState, lineage: "new", serial: 1 }).run
    )
  ).toBeDefined()

  const other = instance()
  writeFileSync(other.state, JSON.stringify(localState))
  const backend = remoteBackend({
    ...localState,
    lineage: "lineage-b",
    resources: [{ type: "y" }],
  })
  expect(() => moveLocalState(other, backend.run)).toThrow("a different state")
  expect(JSON.parse(readFileSync(other.state, "utf8"))).toEqual(localState)
  expect(JSON.parse(backend.remote()).lineage).toBe("lineage-b")
})

test("the empty state GCS creates with its own lineage counts as empty", () => {
  const files = instance("gcp-celld")
  writeFileSync(files.state, JSON.stringify(localState))
  const backend = remoteBackend({
    version: 4,
    serial: 1,
    lineage: "gcs-generated",
    resources: [],
    outputs: {},
  })
  expect(moveLocalState(files, backend.run)).toBeDefined()
  expect(JSON.parse(backend.remote()).resources).toEqual(localState.resources)
})

test("until the move completes, every other command is refused", () => {
  const files = instance()
  writeFileSync(files.state, JSON.stringify(localState))
  expect(() => assertMoved(files, "the init command")).toThrow(
    "the init command"
  )
  writeFileSync(files.state, JSON.stringify({ ...localState, resources: [] }))
  expect(() => assertMoved(files, "init")).not.toThrow()
})

test("a local state without resources is left alone", () => {
  const files = instance()
  writeFileSync(files.state, JSON.stringify({ ...localState, resources: [] }))
  expect(moveLocalState(files, remoteBackend().run)).toBeUndefined()
  expect(readdirSync(files.directory)).toEqual(["terraform.tfstate"])
})

test("a command that changes the installation holds the operation record until it ends", () => {
  const calls: string[] = []
  const store = {
    acquire: (phase: string, takeOver?: string, revision?: string) => {
      calls.push(`acquire ${phase} ${takeOver ?? "-"} ${revision ?? "-"}`)
      return '{"id":"op","version":"1"}'
    },
    finish: () => {
      calls.push("finish")
    },
    stop: (_lease: string, error: string) => {
      calls.push(`stop ${error}`)
    },
  }
  expect(withOperation(store, "terraform-apply", {}, () => 0)).toBe(0)
  expect(
    withOperation(
      store,
      "deploy",
      { takeOver: "op-0", revision: "abc" },
      () => 2
    )
  ).toBe(2)
  // A child killed by a signal has no exit status: the run failed.
  expect(withOperation(store, "deploy", {}, () => null)).toBe(1)
  expect(calls).toEqual([
    "acquire terraform-apply - -",
    "finish",
    "acquire deploy op-0 abc",
    "stop deploy exited with status 2.",
    "acquire deploy - -",
    "stop deploy was interrupted.",
  ])
  expect(changingPhase("apply", [])).toBe("terraform-apply")
  expect(changingPhase("state", ["rm", "x"])).toBe("terraform-state")
  expect(changingPhase("state", ["list"])).toBeUndefined()
  expect(changingPhase("plan", [])).toBeUndefined()
})
