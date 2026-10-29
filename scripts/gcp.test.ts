import { afterEach, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeSource } from "./fixtures/source"
import { gcpName, prepareGcp } from "./gcp"
import { instanceTerraform, REPOSITORY } from "./instance"
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
    deployment: { revision: "b".repeat(40), env_file: path },
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
 * `addresses` as its state and logs every other call.
 */
function initializedInstance(addresses: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "azad-gcp-cli-"))
  directories.push(directory)
  const root = join(REPOSITORY, "roots/gcp-celld")
  const source = fakeSource(directory)
  const files = instanceTerraform(join(directory, "instance"), "gcp-celld")
  mkdirSync(files.data, { recursive: true })
  writeFileSync(
    join(files.data, "terraform.tfstate"),
    JSON.stringify({
      backend: { type: "local", config: { path: files.state } },
    })
  )
  writeFileSync(files.settings, "CLOUDFLARE_API_TOKEN=fixture-deploy-token\n")
  writeFileSync(
    files.vars,
    JSON.stringify({
      project_id: "customer-project",
      region: "me-central1",
      web_host: "board.example.com",
      deployment: {
        revision: "b".repeat(40),
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
if (args[1] === "state" && args[2] === "list") process.stdout.write(${JSON.stringify(addresses.map((address) => `${address}\n`).join(""))})
else appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, data: process.env.TF_DATA_DIR, source: process.env.TF_VAR_source_dir ?? null }) + "\\n")
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
  return { root, source, files, gcp, calls }
}

test("before the cluster exists the first plan covers only it and Clerk's DNS; the full plan follows", () => {
  const first = initializedInstance([])
  // Reading the state needs no source checkout.
  expect(first.gcp("phase").stdout.toString()).toBe("cluster\n")
  const plan = first.gcp(
    "plan",
    "-input=false",
    "-out=terraform.tfplan",
    "--source",
    first.source.path
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
      source: first.source.path,
    },
  ])
  // Applying that saved plan applies it as reviewed: no second, unreviewed phase.
  first.gcp(
    "apply",
    "-input=false",
    "terraform.tfplan",
    "--source",
    first.source.path
  )
  expect(first.calls().at(-1)?.args).toEqual([
    `-chdir=${first.root}`,
    "apply",
    "-input=false",
    join(first.files.directory, "terraform.tfplan"),
  ])

  const second = initializedInstance([
    "module.gke.google_container_cluster.this",
  ])
  expect(second.gcp("phase").stdout.toString()).toBe("full\n")
  second.gcp("plan", "-out=terraform.tfplan", "--source", second.source.path)
  expect(second.calls()[0].args).toEqual([
    `-chdir=${second.root}`,
    "plan",
    `-var-file=${second.files.vars}`,
    `-out=${join(second.files.directory, "terraform.tfplan")}`,
  ])
})

test("plan, apply, destroy and refresh need the app source checkout", () => {
  const instance = initializedInstance([])
  for (const command of ["plan", "apply", "destroy", "refresh"]) {
    const child = instance.gcp(command)
    expect(child.exitCode).toBe(1)
    expect(child.stderr.toString()).toContain("--source is required")
  }
  const refresh = instance.gcp("refresh", "--source", instance.source.path)
  expect(refresh.exitCode).toBe(0)
  expect(
    JSON.parse(readFileSync(instance.files.vars, "utf8")).deployment.revision
  ).toBe(instance.source.revision)
})
