import { afterEach, expect, test } from "bun:test"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "dotenv"
import {
  applyBootstrap,
  bootstrapConfigSchema,
  deploymentGroups,
  planBootstrap,
  tokenPolicies,
  type BootstrapConfig,
  type BootstrapDependencies,
} from "./bootstrap"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const account = "a".repeat(32)
const zone = "b".repeat(32)
const config: BootstrapConfig = {
  version: 1,
  accountId: account,
  webHost: "board.example.com",
  apiHost: "api.example.com",
  revision: "c".repeat(40),
  miniApps: true,
  verifyDatabaseCertificate: true,
}
const groups = [
  ...[
    "Account Settings Read",
    "Workers Scripts Write",
    "Workers R2 Storage Write",
    "Queues Write",
    "Hyperdrive Write",
    "Pages Write",
    "D1 Write",
    "Account: SSL and Certificates Read",
  ].map((name) => ({ name, scopes: ["com.cloudflare.api.account"] })),
  ...["Zone Read", "DNS Write", "Workers Routes Write"].map((name) => ({
    name,
    scopes: ["com.cloudflare.api.account.zone"],
  })),
  ...["Artifacts Read", "Artifacts Write"].map((name) => ({
    name,
    scopes: ["com.cloudflare.api.account"],
  })),
  // The Google Cloud target's zone grants (DNS and TLS only).
  ...["SSL and Certificates Write", "Config Settings Write"].map((name) => ({
    name,
    scopes: ["com.cloudflare.api.account.zone"],
  })),
].map((group, i) => ({ ...group, id: (i + 1).toString(16).padStart(32, "0") }))
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "azad-token-bootstrap-"))
  dirs.push(directory)
  const remote = new Map<string, { id: string; name: string; value: string }>()
  const saved = new Map<string, { id: string; name: string; value: string }>()
  let nextId = 20
  let failBeforeApply = false
  let failAfterApply = false
  let wrongAccount = false
  let pageSize = 50
  const environments: Record<string, string>[] = []
  type Plan = {
    resource_changes: {
      address: string
      type: string
      change: { actions: string[] }
    }[]
  }
  let plan: Plan = { resource_changes: [] }
  const deps: BootstrapDependencies = {
    fetcher: (async (input, init) => {
      const url = new URL(String(input))
      const auth = new Headers(init?.headers).get("Authorization")
      if (url.pathname.endsWith("/user/tokens/verify")) {
        const token = [...remote.values()].find(
          (entry) => auth === `Bearer ${entry.value}`
        )
        return token
          ? Response.json({
              success: true,
              result: { id: token.id, status: "active" },
            })
          : Response.json({ success: false }, { status: 401 })
      }
      if (url.pathname.endsWith("/permission_groups"))
        return Response.json({ success: true, result: groups })
      if (url.pathname.endsWith("/user/tokens")) {
        const page = Number(url.searchParams.get("page"))
        return Response.json({
          success: true,
          result: [...remote.values()]
            .slice((page - 1) * pageSize, page * pageSize)
            .map(({ id, name }) => ({ id, name, status: "active" })),
          result_info: { total_pages: Math.ceil(remote.size / pageSize) },
        })
      }
      if (url.pathname.endsWith("/zones")) {
        expect(auth).toBe(`Bearer ${remote.get("discovery")?.value}`)
        return Response.json({
          success: true,
          result:
            url.searchParams.get("name") === "example.com"
              ? [
                  {
                    id: zone,
                    name: "example.com",
                    account: { id: wrongAccount ? "d".repeat(32) : account },
                  },
                ]
              : [],
        })
      }
      throw new Error("Unexpected external request")
    }) as typeof fetch,
    async run(args, env) {
      environments.push(env)
      const root = join(directory, "terraform")
      if (args[2] === "init") return ""
      if (args[2] === "plan") {
        const variables = JSON.parse(
          readFileSync(join(root, "terraform.tfvars.json"), "utf8")
        ) as { tokens: Record<string, { name: string }> }
        plan = {
          resource_changes: [
            ...new Set([...saved.keys(), ...Object.keys(variables.tokens)]),
          ].map((key) => ({
            address: `cloudflare_api_token.scoped["${key}"]`,
            type: "cloudflare_api_token",
            change: {
              actions: [
                !variables.tokens[key]
                  ? "delete"
                  : saved.has(key)
                    ? "no-op"
                    : "create",
              ],
            },
          })),
        }
        return ""
      }
      if (args[2] === "show") return JSON.stringify(plan)
      if (args[2] === "apply") {
        if (failBeforeApply) {
          failBeforeApply = false
          throw new Error("simulated interruption before mutation")
        }
        const variables = JSON.parse(
          readFileSync(join(root, "terraform.tfvars.json"), "utf8")
        ) as { tokens: Record<string, { name: string }> }
        for (const key of saved.keys())
          if (!variables.tokens[key]) {
            saved.delete(key)
            remote.delete(key)
          }
        for (const [key, value] of Object.entries(variables.tokens))
          if (!saved.has(key)) {
            const token = {
              id: (nextId++).toString(16).padStart(32, "0"),
              name: value.name,
              value: `fake-derived-${key}-${nextId}`,
            }
            saved.set(key, token)
            remote.set(key, token)
          }
        writeFileSync(
          join(root, "terraform.tfstate"),
          JSON.stringify({
            resources: [
              {
                type: "cloudflare_api_token",
                name: "scoped",
                instances: [...saved.entries()].map(([key, token]) => ({
                  index_key: key,
                  attributes: { id: token.id, value: token.value },
                })),
              },
            ],
          }),
          { mode: 0o600 }
        )
        if (failAfterApply) {
          failAfterApply = false
          throw new Error("simulated interruption after persisted mutation")
        }
        return ""
      }
      throw new Error("Unexpected Terraform operation")
    },
  }
  return {
    directory,
    smallPages: () => {
      pageSize = 1
    },
    deps,
    remote,
    environments,
    interruptBefore: () => {
      failBeforeApply = true
    },
    interruptAfter: () => {
      failAfterApply = true
    },
    wrongAccount: () => {
      wrongAccount = true
    },
  }
}

test("plan checks authority without creating credentials or pretending zone discovery happened", async () => {
  const f = fixture()
  const result = await planBootstrap(config, "fake-bootstrap", f.deps)
  expect(result.zonesResolvedDuringApply).toBe(true)
  expect(f.remote.size).toBe(0)
  expect(f.environments).toEqual([])
})
test("deployment and runtime grants stay in the selected account and exact discovered zones", () => {
  const policies = tokenPolicies(config, groups, [zone], true)
  expect(JSON.parse(policies.discovery.policies[0].resources)).toEqual({
    [`com.cloudflare.api.account.${account}`]: {
      "com.cloudflare.api.account.zone.*": "*",
    },
  })
  expect(JSON.parse(policies.deployment.policies[1].resources)).toEqual({
    [`com.cloudflare.api.account.zone.${zone}`]: "*",
  })
  expect(policies.deployment.policies[0].permission_groups).toEqual(
    [1, 2, 3, 4, 5, 6, 8].map((i) => ({ id: i.toString(16).padStart(32, "0") }))
  )
  expect(policies.miniapps.policies[0].permission_groups).toEqual([
    { id: "0".repeat(31) + "2" },
    { id: "0".repeat(31) + "7" },
  ])
  expect(JSON.parse(policies.miniapps.policies[0].resources)).toEqual({
    [`com.cloudflare.api.account.${account}`]: "*",
  })
})
test("apply hands off only derived credentials and deletes discovery; retry keeps token identities", async () => {
  const f = fixture()
  const first = await applyBootstrap(
    config,
    "fake-bootstrap",
    f.directory,
    f.deps
  )
  const credentials = parse(readFileSync(first.credentialsFile, "utf8"))
  expect(Object.keys(credentials).sort()).toEqual([
    "CLOUDFLARE_API_TOKEN",
    "V3_CF_API_TOKEN",
  ])
  expect(JSON.stringify(first)).not.toContain("fake-")
  expect(readFileSync(first.credentialsFile, "utf8")).not.toContain(
    "fake-bootstrap"
  )
  expect(f.remote.has("discovery")).toBe(false)
  expect(statSync(first.credentialsFile).mode & 0o777).toBe(0o600)
  const second = await applyBootstrap(
    config,
    "fake-bootstrap",
    f.directory,
    f.deps
  )
  expect(second.tokenIds).toEqual(first.tokenIds)
  expect(
    f.environments.every(
      (env) =>
        !env.TF_LOG && !env.TF_CLI_ARGS && !env.CLOUDFLARE_BOOTSTRAP_API_TOKEN
    )
  ).toBe(true)
})
test("an interrupted first token attempt can retry without replacing retained tokens", async () => {
  const f = fixture()
  f.interruptBefore()
  await expect(
    applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  ).rejects.toThrow("interruption")
  expect(f.remote.size).toBe(0)
  const result = await applyBootstrap(
    config,
    "fake-bootstrap",
    f.directory,
    f.deps
  )
  expect(Object.keys(result.tokenIds)).toEqual(["deployment", "miniapps"])
})
test("a persisted discovery token survives interruption and is reused on resume", async () => {
  const f = fixture()
  f.interruptAfter()
  await expect(
    applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  ).rejects.toThrow("interruption")
  expect(f.remote.size).toBe(1)
  await applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  expect(f.remote.size).toBe(2)
})
test("lost state stops instead of minting a second set of credentials", async () => {
  const f = fixture()
  await applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  const before = [...f.remote.values()]
  unlinkSync(join(f.directory, "terraform/terraform.tfstate"))
  await expect(
    applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  ).rejects.toThrow("state is missing")
  expect([...f.remote.values()]).toEqual(before)
  unlinkSync(join(f.directory, "receipt.json"))
  await expect(
    applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  ).rejects.toThrow("without matching usable private state")
})
test("wrong account zone metadata fails before granting write permissions", async () => {
  const f = fixture()
  f.wrongAccount()
  await expect(
    applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  ).rejects.toThrow("different account")
  expect([...f.remote.keys()]).toEqual(["discovery"])
})
test("source/account/feature drift cannot reuse an installation bootstrap receipt", async () => {
  const f = fixture()
  await applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  for (const different of [
    { ...config, revision: "e".repeat(40) },
    { ...config, miniApps: false },
    { ...config, accountId: "e".repeat(32) },
  ]) {
    await expect(
      applyBootstrap(different, "fake-bootstrap", f.directory, f.deps)
    ).rejects.toThrow("differs from its saved receipt")
  }
})
test("managed project source can be added to a completed bootstrap without replacing its tokens", async () => {
  const f = fixture()
  const first = await applyBootstrap(
    config,
    "fake-bootstrap",
    f.directory,
    f.deps
  )
  const managed = { ...config, managedSource: true }
  const policies = tokenPolicies(managed, groups, [zone], false)
  expect(policies["managed-source"].policies[0].permission_groups).toEqual([
    { id: "0".repeat(31) + "c" },
    { id: "0".repeat(31) + "d" },
  ])
  expect(policies["managed-events"].policies[0].permission_groups).toEqual([
    { id: "0".repeat(31) + "4" },
  ])
  const second = await applyBootstrap(
    managed,
    "fake-bootstrap",
    f.directory,
    f.deps
  )
  expect(second.tokenIds).toMatchObject(first.tokenIds)
  expect(Object.keys(second.tokenIds).sort()).toEqual([
    "deployment",
    "managed-events",
    "managed-source",
    "miniapps",
  ])
  expect(
    Object.keys(parse(readFileSync(second.credentialsFile, "utf8"))).sort()
  ).toEqual([
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ARTIFACTS_API_TOKEN",
    "CLOUDFLARE_ARTIFACTS_EVENTS_API_TOKEN",
    "V3_CF_API_TOKEN",
  ])
  // Once added it is part of the installation; removing it is drift.
  await expect(
    applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  ).rejects.toThrow("differs from its saved receipt")
})
test("revoked or foreign-owned saved tokens are not automatically replaced", async () => {
  const f = fixture()
  await applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  f.remote.delete("deployment")
  await expect(
    applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  ).rejects.toThrow("absent from the administrator")
})
test("missing or unselectable required permissions fail before any mutation", async () => {
  expect(() =>
    tokenPolicies(
      config,
      groups.filter((g) => g.name !== "Pages Write"),
      [zone],
      true
    )
  ).toThrow("Pages Write")
  expect(() =>
    tokenPolicies(
      config,
      groups.map((g) => ({ ...g, is_selectable: false })),
      [zone],
      true
    )
  ).toThrow("administrator")
  const disabled = tokenPolicies(
    { ...config, miniApps: false, verifyDatabaseCertificate: false },
    groups.filter(
      (g) =>
        !["D1 Write", "Account: SSL and Certificates Read"].includes(g.name)
    ),
    [zone],
    false
  )
  expect(Object.keys(disabled)).toEqual(["deployment"])
})

test("CLI rejects a non-private bootstrap file without echoing credentials", async () => {
  const f = fixture()
  const configFile = join(f.directory, "config.json")
  const secretFile = join(f.directory, "bootstrap.env")
  writeFileSync(configFile, JSON.stringify(config))
  writeFileSync(
    secretFile,
    "CLOUDFLARE_BOOTSTRAP_API_TOKEN=never-print-this-fixture\n",
    { mode: 0o644 }
  )
  chmodSync(secretFile, 0o644)
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "bootstrap.ts"),
      "plan",
      "--config",
      configFile,
      "--bootstrap-file",
      secretFile,
      "--state-dir",
      join(f.directory, "state"),
    ],
    { stdout: "pipe", stderr: "pipe" }
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code).toBe(1)
  expect(stdout).toBe("")
  expect(stderr).toContain("private files")
  expect(stderr).not.toContain("never-print-this-fixture")
  expect(f.remote.size).toBe(0)
})

test("CLI --help prints the usage; an unknown option gets the usage, not a generic failure", () => {
  const run = (...args: string[]) =>
    Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "bootstrap.ts"),
        ...args,
      ],
      { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" }
    )
  for (const flag of ["--help", "-h", "help"]) {
    const child = run(flag)
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toStartWith(
      "Usage: bootstrap.ts plan|apply "
    )
    expect(child.stderr.toString()).toBe("")
  }
  const unknown = run("plan", "--state", "/nowhere")
  expect(unknown.exitCode).toBe(1)
  expect(unknown.stdout.toString()).toBe("")
  expect(unknown.stderr.toString()).toStartWith(
    "Usage: bootstrap.ts plan|apply "
  )
})

test("a held state lock names itself and is left in place", async () => {
  const f = fixture()
  const lock = join(f.directory, "bootstrap.lock")
  writeFileSync(lock, "12345", { mode: 0o600 })
  await expect(
    applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  ).rejects.toThrow(`${lock} exists: another bootstrap is running`)
  expect(readFileSync(lock, "utf8")).toBe("12345")
  expect(f.remote.size).toBe(0)
})

test("owned token collisions on later short pages stop fresh bootstrap", async () => {
  const f = fixture()
  await applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  const deployment = f.remote.get("deployment")!
  f.remote.clear()
  f.remote.set("unrelated", {
    id: "f".repeat(32),
    name: "unrelated-other-install",
    value: "fake-unrelated",
  })
  f.remote.set("deployment", deployment)
  f.smallPages()
  unlinkSync(join(f.directory, "terraform/terraform.tfstate"))
  unlinkSync(join(f.directory, "receipt.json"))
  await expect(
    applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
  ).rejects.toThrow("without matching usable private state")
  expect(f.remote.size).toBe(2)
})

test("rolled deployment or runtime secrets are refused without replacing or handing off stale credentials", async () => {
  for (const key of ["deployment", "miniapps"]) {
    const f = fixture()
    await applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
    const retained = f.remote.get(key)!
    f.remote.set(key, { ...retained, value: "fake-rolled-secret" })
    await expect(
      applyBootstrap(config, "fake-bootstrap", f.directory, f.deps)
    ).rejects.toThrow("invalid or rotated")
    expect(f.remote.get(key)?.id).toBe(retained.id)
    expect(f.remote.size).toBe(2)
  }
})

test("certificate registration grants account certificate Write only when explicitly selected", async () => {
  const catalog = [
    ...groups,
    {
      id: "f".repeat(32),
      name: "Account: SSL and Certificates Write",
      scopes: ["com.cloudflare.api.account"],
    },
  ]
  const created = tokenPolicies(
    { ...config, registerDatabaseCertificate: true },
    catalog,
    [zone],
    false
  )
  const existing = tokenPolicies(config, catalog, [zone], false)
  expect(created.deployment.policies[0].permission_groups).toContainEqual({
    id: "f".repeat(32),
  })
  expect(created.deployment.policies[0].permission_groups).not.toContainEqual({
    id: "0".repeat(31) + "8",
  })
  expect(existing.deployment.policies[0].permission_groups).not.toContainEqual({
    id: "f".repeat(32),
  })
  expect(() =>
    bootstrapConfigSchema.parse({
      ...config,
      verifyDatabaseCertificate: false,
      registerDatabaseCertificate: true,
    })
  ).toThrow()
  const f = fixture()
  const first = await applyBootstrap(
    config,
    "fake-bootstrap",
    f.directory,
    f.deps
  )
  const second = await applyBootstrap(
    { ...config, registerDatabaseCertificate: false },
    "fake-bootstrap",
    f.directory,
    f.deps
  )
  expect(second.tokenIds).toEqual(first.tokenIds)
})

test("Google Cloud deployments get only zone DNS, Origin CA and Configuration Rule grants", () => {
  const config = bootstrapConfigSchema.parse({
    version: 1,
    accountId: "a".repeat(32),
    webHost: "board.example.com",
    apiHost: "api.board.example.com",
    revision: "b".repeat(40),
    miniApps: false,
    verifyDatabaseCertificate: false,
    target: "gcp",
  })
  expect(deploymentGroups(config)).toEqual({
    account: [],
    zone: [
      "Zone Read",
      "DNS Write",
      "SSL and Certificates Write",
      "Config Settings Write",
    ],
  })
  expect(() =>
    bootstrapConfigSchema.parse({ ...config, miniApps: true })
  ).toThrow()
})

test("on Google Cloud, managed project source gets its Artifacts token but no queue token", async () => {
  const f = fixture()
  const managed: BootstrapConfig = {
    ...config,
    miniApps: false,
    verifyDatabaseCertificate: false,
    target: "gcp",
    managedSource: true,
  }
  const policies = tokenPolicies(managed, groups, [zone], false)
  expect(Object.keys(policies).sort()).toEqual(["deployment", "managed-source"])
  const result = await applyBootstrap(
    managed,
    "fake-bootstrap",
    f.directory,
    f.deps
  )
  expect(
    Object.keys(parse(readFileSync(result.credentialsFile, "utf8"))).sort()
  ).toEqual(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ARTIFACTS_API_TOKEN"])
})
