import { afterEach, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fakeRelease } from "./fixtures/source"
import { gcpName, prepareGcp } from "./gcp"
import { instanceTerraform, REPOSITORY } from "./instance"
import { ownBackendFile } from "./own-backend"
import {
  initializeOwnBackend,
  pointerState,
  recordedState,
  stateTerraform,
} from "./fixtures/terraform"
import { gcpStore } from "./state"
import { SettingsRefused, type AppSettings } from "./source"

const account = "a".repeat(32)
const zone = "c".repeat(32)
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function credentials(lines: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "azad-gcp-"))
  directories.push(directory)
  const path = join(directory, ".env")
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 })
  return path
}

/** The app's settings entrypoint accepts every credential file here. */
const app: AppSettings = {
  resourcePrefix: () => "azad-fixture-prefix",
  storage: () => ({ kind: "r2" }),
  validate: () => undefined,
}

const liveKeys = [
  "CLOUDFLARE_API_TOKEN=fixture-deploy-token",
  `CLERK_PUBLISHABLE_KEY=pk_live_${Buffer.from("clerk.board.example.com$").toString("base64")}`,
  "CLERK_SECRET_KEY=sk_live_fixture",
]

/** Cloudflare has example.com in the account; Clerk asks for two CNAMEs, one already present. */
function providers(
  existing: Record<string, { type: string; content: string }>
) {
  const calls: string[] = []
  const fetcher = async (url: string | URL | Request) => {
    const address = new URL(String(url))
    calls.push(`${address.hostname}${address.pathname}`)
    if (address.href === "https://api.clerk.com/v1/domains")
      return Response.json({
        data: [
          {
            name: "board.example.com",
            is_satellite: false,
            cname_targets: [
              {
                host: "clerk.board.example.com",
                value: "frontend-api.clerk.services",
              },
              {
                host: "accounts.board.example.com",
                value: "accounts.clerk.services",
              },
            ],
          },
        ],
      })
    if (address.pathname.endsWith("/zones")) {
      const name = address.searchParams.get("name")
      return Response.json({
        success: true,
        result:
          name === "example.com" &&
          address.searchParams.get("account.id") === account
            ? [{ id: zone, name: "example.com" }]
            : [],
      })
    }
    if (address.pathname.endsWith("/dns_records")) {
      const record = existing[address.searchParams.get("name") ?? ""]
      return Response.json({ success: true, result: record ? [record] : [] })
    }
    throw new Error(`Unexpected ${address.href}`)
  }
  return { calls, fetcher }
}

const input = {
  projectId: "customer-project",
  region: "me-central1",
  webHost: "board.example.com",
  accountId: account,
  revision: "b".repeat(40),
  version: "4.496.0",
  evaluation: false,
}

test("setup derives the zone and only the Clerk records DNS still lacks, with no secret in the variables", async () => {
  const api = providers({
    "accounts.board.example.com": {
      type: "CNAME",
      content: "accounts.clerk.services",
    },
  })
  const path = credentials(liveKeys)
  const result = await prepareGcp(
    { ...input, credentialsPath: path },
    app,
    api.fetcher
  )
  expect(result.tfvars).toEqual({
    project_id: "customer-project",
    region: "me-central1",
    name: gcpName("board.example.com"),
    web_host: "board.example.com",
    cloudflare_zone_id: zone,
    deployment: {
      revision: "b".repeat(40),
      version: "4.496.0",
      env_file: path,
    },
    disk_backups: { schedule: "daily" },
    clerk_dns: {
      zone_id: zone,
      records: { "clerk.board.example.com": "frontend-api.clerk.services" },
    },
  })
  expect(JSON.stringify(result.tfvars)).not.toContain("fixture")
})

test("evaluation sizing selects Spot nodes, the smallest database and a removable install", async () => {
  const api = providers({})
  const keys = [...liveKeys, "AZAD_CLI_CLERK_APP_ID=app_2fixture"]
  const result = await prepareGcp(
    { ...input, evaluation: true, credentialsPath: credentials(keys) },
    app,
    api.fetcher
  )
  expect(result.tfvars).toMatchObject({
    spot: true,
    deletion_protection: false,
    database: { tier: "db-f1-micro", backups: false },
    // Destroy removes the Clerk application the setup created with everything else.
    clerk_application: { id: "app_2fixture", delete_on_destroy: true },
  })
  const production = await prepareGcp(
    { ...input, credentialsPath: credentials(keys) },
    app,
    api.fetcher
  )
  expect(production.tfvars.clerk_application).toEqual({
    id: "app_2fixture",
    delete_on_destroy: false,
  })
})

test("development Clerk keys need no DNS records", async () => {
  const api = providers({})
  const result = await prepareGcp(
    {
      ...input,
      credentialsPath: credentials([
        "CLOUDFLARE_API_TOKEN=fixture-deploy-token",
        "CLERK_PUBLISHABLE_KEY=pk_test_Zml4dHVyZSQ=",
        "CLERK_SECRET_KEY=sk_test_fixture",
      ]),
    },
    app,
    api.fetcher
  )
  expect(result.tfvars.clerk_dns).toBeUndefined()
  expect(api.calls).not.toContain("api.clerk.com/v1/domains")
})

test("settings the app refuses for a celld installation fail before any provider is read", async () => {
  const api = providers({})
  const targets: string[] = []
  await expect(
    prepareGcp(
      {
        ...input,
        credentialsPath: credentials([...liveKeys, "GITHUB_APP_ID=12345"]),
      },
      {
        ...app,
        validate: (target, settings) => {
          targets.push(target)
          if (settings.GITHUB_APP_ID && !settings.GITHUB_APP_PRIVATE_KEY)
            throw new SettingsRefused("Configure all of: GITHUB_APP_ID, …")
        },
      },
      api.fetcher
    )
  ).rejects.toThrow("Configure all of: GITHUB_APP_ID")
  expect(targets).toEqual(["celld"])
  expect(api.calls).toEqual([])
})

test("a hostname outside the account's zones is refused", async () => {
  const api = providers({})
  await expect(
    prepareGcp(
      {
        ...input,
        webHost: "board.example.org",
        credentialsPath: credentials(liveKeys),
      },
      app,
      api.fetcher
    )
  ).rejects.toThrow("board.example.org is not in a Cloudflare zone")
})

test("names stay within Google's limits and differ per hostname", () => {
  const long = gcpName("a-very-long-first-label-for-a-board.example.com")
  expect(`${long}-celld`.length).toBeLessThanOrEqual(40)
  expect(long).toMatch(/^azad-[a-z0-9-]+-[a-f0-9]{4}$/u)
  expect(gcpName("one.example.com")).not.toBe(gcpName("one.example.org"))
})

test("the disk backup frequency chosen at setup reaches Terraform", async () => {
  const api = providers({})
  const result = await prepareGcp(
    { ...input, diskBackups: "hourly", credentialsPath: credentials(liveKeys) },
    app,
    api.fetcher
  )
  expect(result.tfvars.disk_backups).toEqual({ schedule: "hourly" })
})

test("the agent machine chosen at setup reaches Terraform with the label project setup shows", async () => {
  const api = providers({})
  const result = await prepareGcp(
    {
      ...input,
      agentMachine: "n2-custom-8-16384",
      credentialsPath: credentials(liveKeys),
    },
    app,
    api.fetcher
  )
  expect(result.tfvars.agent_machine).toEqual({
    machine_type: "n2-custom-8-16384",
    label: "8 vCPU · 16 GB",
  })
  const none = await prepareGcp(
    { ...input, credentialsPath: credentials(liveKeys) },
    app,
    api.fetcher
  )
  expect(none.tfvars.agent_machine).toBeUndefined()
})

/**
 * An initialized Google Cloud instance and a `terraform` on PATH that lists
 * `addresses` as its state, answers `deploy` as the root's handoff and logs
 * every other call.
 */
function initializedInstance(
  addresses: string[],
  deploy: object | null = null
) {
  const directory = mkdtempSync(join(tmpdir(), "azad-gcp-cli-"))
  directories.push(directory)
  const root = join(REPOSITORY, "roots/gcp-celld")
  const release = fakeRelease(directory)
  const files = instanceTerraform(join(directory, "instance"), "gcp-celld")
  const store = gcpStore("azad-board-1234", "customer-project")
  mkdirSync(files.data, { recursive: true })
  writeFileSync(
    join(files.data, "terraform.tfstate"),
    JSON.stringify({
      backend: { type: "gcs", config: { bucket: store.bucket } },
    })
  )
  writeFileSync(files.backendRecord, JSON.stringify({ store }))
  writeFileSync(files.settings, "CLOUDFLARE_API_TOKEN=fixture-deploy-token\n")
  writeFileSync(
    files.vars,
    JSON.stringify({
      project_id: "customer-project",
      region: "me-central1",
      name: "azad-board-1234",
      web_host: "board.example.com",
      deployment: {
        revision: release.revision,
        version: release.version,
        env_file: files.settings,
        state_directory: join(files.directory, "celld-install"),
      },
    })
  )
  const bin = join(directory, "bin")
  mkdirSync(bin)
  const log = join(directory, "calls.jsonl")
  writeFileSync(
    join(bin, "terraform"),
    `#!/usr/bin/env -S bun --no-env-file
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
if (args[1] === "state" && args[2] === "pull") {}
else if (args[1] === "state" && args[2] === "list") process.stdout.write(${JSON.stringify(addresses.map((address) => `${address}\n`).join(""))})
else if (args[1] === "output") process.stdout.write(${JSON.stringify(JSON.stringify(deploy))})
else {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, data: process.env.TF_DATA_DIR, firstDeployPending: process.env.TF_VAR_first_deploy_pending }) + "\\n")
  appendFileSync(${JSON.stringify(`${log}.bucket`)}, (process.env.TF_VAR_install_bucket ?? "") + "\\n")
}
`,
    { mode: 0o755 }
  )
  const gcp = (...args: string[]) =>
    Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "gcp.ts"),
        ...args,
        "--instance-dir",
        files.instance,
      ],
      {
        env: { PATH: `${bin}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  const buckets = () =>
    readFileSync(`${log}.bucket`, "utf8").split("\n").filter(Boolean)
  return { root, release, files, gcp, calls, buckets, store }
}

test("before the cluster exists the first plan covers only it and Clerk's DNS; the full plan follows", () => {
  const first = initializedInstance([])
  // Reading the state needs no release.
  expect(first.gcp("phase").stdout.toString()).toBe("cluster\n")
  const plan = first.gcp(
    "plan",
    "-input=false",
    "-out=terraform.tfplan",
    "--release",
    first.release.path
  )
  expect(plan.exitCode).toBe(0)
  expect(plan.stdout.toString()).toContain("1 of 2")
  expect(first.calls()).toEqual([
    {
      args: [
        `-chdir=${first.root}`,
        "plan",
        "-target=module.gke",
        "-target=module.clerk_dns",
        `-var-file=${first.files.vars}`,
        "-input=false",
        `-out=${join(first.files.directory, "terraform.tfplan")}`,
      ],
      data: first.files.data,
      firstDeployPending: "false",
    },
  ])
  // Applying that saved plan applies it as reviewed: no second, unreviewed phase.
  first.gcp(
    "apply",
    "-input=false",
    "terraform.tfplan",
    "--release",
    first.release.path
  )
  expect(first.calls().at(-1)?.args).toEqual([
    `-chdir=${first.root}`,
    "apply",
    "-input=false",
    join(first.files.directory, "terraform.tfplan"),
  ])
  // The plan asked whether a deploy happened; the apply held the
  // installation's operation record, and released it.
  const calls = readFileSync(
    join(first.release.path, "state-calls.jsonl"),
    "utf8"
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  expect(calls.map((call) => call.command)).toEqual([
    "deployed",
    "acquire",
    "finish",
  ])
  const held = calls.slice(1)
  expect(held[0].args.slice(0, 2)).toEqual(["--phase", "terraform-apply"])
  expect(held[0].state.store).toEqual(
    gcpStore("azad-board-1234", "customer-project")
  )

  const second = initializedInstance([
    "module.gke.google_container_cluster.this",
  ])
  expect(second.gcp("phase").stdout.toString()).toBe("full\n")
  second.gcp("plan", "-out=terraform.tfplan", "--release", second.release.path)
  expect(second.calls()[0].args).toEqual([
    `-chdir=${second.root}`,
    "plan",
    `-var-file=${second.files.vars}`,
    `-out=${join(second.files.directory, "terraform.tfplan")}`,
  ])
})

test("until the first deploy, DNS does not wait for fleets that serve nothing yet", () => {
  const cluster = "module.gke.google_container_cluster.this"
  const fresh = initializedInstance([cluster])
  writeFileSync(join(fresh.release.path, "not-deployed"), "")
  fresh.gcp("plan", "-out=terraform.tfplan", "--release", fresh.release.path)
  expect(fresh.calls()[0].firstDeployPending).toBe("true")

  // A direct apply before the cluster exists also runs the full apply.
  const direct = initializedInstance([])
  writeFileSync(join(direct.release.path, "not-deployed"), "")
  direct.gcp("apply", "-input=false", "--release", direct.release.path)
  expect(direct.calls().map((call) => call.firstDeployPending)).toEqual([
    "true",
    "true",
  ])

  // Once a deploy recorded its receipt, DNS waits on the load balancer again.
  const deployed = initializedInstance([cluster])
  deployed.gcp(
    "plan",
    "-out=terraform.tfplan",
    "--release",
    deployed.release.path
  )
  expect(deployed.calls()[0].firstDeployPending).toBe("false")
})

test("every Terraform run gets the installation's state bucket, which the updater's grants name", () => {
  const instance = initializedInstance([
    "module.gke.google_container_cluster.this",
  ])
  expect(
    instance.gcp(
      "plan",
      "-out=terraform.tfplan",
      "--release",
      instance.release.path
    ).exitCode
  ).toBe(0)
  expect(instance.buckets()).toEqual([instance.store.bucket])
  expect(instance.store.bucket).toBe(
    gcpStore("azad-board-1234", "customer-project").bucket
  )
})

test("with a backend_override.tf, commands run in the installation's copy of the root, with its own working data", () => {
  const instance = initializedInstance([])
  writeFileSync(
    ownBackendFile(instance.files),
    'terraform {\n  backend "gcs" {\n    bucket = "team-state"\n  }\n}\n'
  )
  const terraform = stateTerraform(dirname(instance.files.instance))
  const gcp = (...args: string[]) =>
    Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "gcp.ts"),
        ...args,
        "--release",
        instance.release.path,
        "--instance-dir",
        instance.files.instance,
      ],
      { env: { PATH: terraform.path }, stdout: "pipe", stderr: "pipe" }
    )
  const refused = gcp("plan", "-out=terraform.tfplan")
  expect(refused.exitCode).toBe(1)
  expect(refused.stderr.toString()).toContain("not initialized yet")
  initializeOwnBackend(instance.files.directory)
  terraform.answer(
    "bucket-state",
    pointerState({ backend: "gcs", lineage: "lineage-own", serial: 3 })
  )
  terraform.answer("root", recordedState("lineage-own"))
  const planned = gcp("plan", "-out=terraform.tfplan")
  expect(planned.stderr.toString()).toBe("")
  expect(planned.exitCode).toBe(0)
  const data = join(instance.files.directory, ".terraform-own")
  expect(terraform.calls().map(({ args, data }) => ({ args, data }))).toEqual([
    {
      args: [
        `-chdir=${join(instance.files.directory, "own-backend", "roots", "gcp-celld")}`,
        "state",
        "list",
      ],
      data,
    },
    {
      args: [
        `-chdir=${join(instance.files.directory, "own-backend", "roots", "gcp-celld")}`,
        "plan",
        "-target=module.gke",
        "-target=module.clerk_dns",
        `-var-file=${instance.files.vars}`,
        `-out=${join(instance.files.directory, "terraform.tfplan")}`,
      ],
      data,
    },
  ])
})

test("a check that passed before the operation record is taken is made again inside it", () => {
  const instance = initializedInstance([])
  const terraform = stateTerraform(dirname(instance.files.instance))
  terraform.answer(
    "root",
    recordedState("lineage-bucket"),
    pointerState({ backend: "s3", lineage: "lineage-bucket", serial: 9 })
  )
  const apply = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "gcp.ts"),
      "destroy",
      "--release",
      instance.release.path,
      "--instance-dir",
      instance.files.instance,
    ],
    { env: { PATH: terraform.path }, stdout: "pipe", stderr: "pipe" }
  )
  expect(apply.exitCode).toBe(1)
  expect(apply.stderr.toString()).toContain("holds only a pointer")
  expect(
    terraform.calls().filter((call) => call.args[1] === "destroy")
  ).toEqual([])
})

test("plan, apply, destroy and refresh need the release; refresh records its sourceSha and version", () => {
  const instance = initializedInstance([])
  for (const command of ["plan", "apply", "destroy", "refresh"]) {
    const child = instance.gcp(command)
    expect(child.exitCode).toBe(1)
    expect(child.stderr.toString()).toContain("--release is required")
  }
  const next = fakeRelease(join(dirname(instance.files.instance), "next"), {
    version: "4.498.0",
    revision: "d".repeat(40),
  })
  const refresh = instance.gcp("refresh", "--release", next.path)
  expect(refresh.exitCode).toBe(0)
  expect(
    JSON.parse(readFileSync(instance.files.vars, "utf8")).deployment
  ).toMatchObject({ revision: "d".repeat(40), version: "4.498.0" })
})

test("deploy runs the release's celld-install.js from its payload and keeps its output in install.log", () => {
  const instance = initializedInstance(
    ["module.gke.google_container_cluster.this"],
    { fleets: { api: "azad-api" } }
  )
  const deploy = instance.gcp("deploy", "--release", instance.release.path)
  expect(deploy.stderr.toString()).toBe("")
  expect(deploy.exitCode).toBe(0)
  const installed = readFileSync(
    join(instance.release.path, "install-calls.jsonl"),
    "utf8"
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  expect(installed).toHaveLength(1)
  expect(installed[0]).toMatchObject({
    entry: "celld-install",
    args: [],
    cwd: instance.release.payload,
    handoff: {
      revision: instance.release.revision,
      env_file: instance.files.settings,
      state_directory: join(instance.files.directory, "celld-install"),
      install_store: instance.store,
      operation_id: "operation-fixture",
    },
  })
  expect(deploy.stdout.toString()).toContain("celld-install ran")
  expect(
    readFileSync(
      join(instance.files.directory, "celld-install", "install.log"),
      "utf8"
    )
  ).toContain("celld-install ran")
})

test("--help prints the usage without an instance directory", () => {
  for (const flag of ["--help", "-h", "help"]) {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "gcp.ts"),
        flag,
      ],
      { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" }
    )
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toStartWith("Usage: gcp.ts setup ")
    expect(child.stderr.toString()).toBe("")
  }
})

test("a failed Cloudflare lookup during setup reports its own reason", () => {
  const directory = mkdtempSync(join(tmpdir(), "azad-gcp-lookup-"))
  directories.push(directory)
  const release = fakeRelease(directory)
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "gcp.ts"),
      "setup",
      "--credentials",
      credentials(liveKeys),
      "--project-id",
      input.projectId,
      "--region",
      input.region,
      "--web-host",
      input.webHost,
      "--account-id",
      account,
      "--release",
      release.path,
      "--instance-dir",
      join(directory, "instance"),
    ],
    {
      // Nothing listens on the discard port, so the lookup cannot connect.
      env: { PATH: process.env.PATH, HTTPS_PROXY: "http://127.0.0.1:9" },
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  expect(child.exitCode).toBe(1)
  expect(child.stderr.toString()).toContain(
    "Setup could not reach api.cloudflare.com"
  )
})
