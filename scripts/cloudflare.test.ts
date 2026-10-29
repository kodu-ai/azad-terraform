import { afterEach, expect, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "dotenv"
import { clerkDns, prepareCloudflare, saveCloudflare } from "./cloudflare"
import { fakeSource } from "./fixtures/source"
import {
  instanceTerraform,
  REPOSITORY,
  type InstanceTerraform,
} from "./instance"
import { SettingsRefused, type AppSettings } from "./source"

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})
const credentials = [
  "CLOUDFLARE_API_TOKEN=fake-cf-token",
  "CLERK_PUBLISHABLE_KEY=pk_test_fake",
  "CLERK_SECRET_KEY=sk_test_fake",
  "CLERK_WEBHOOK_SECRET=whsec_fake",
  "GITHUB_APP_ID=12345",
  "GITHUB_APP_CLIENT_SECRET=fake-github-secret",
  `GITHUB_APP_PRIVATE_KEY="${privateKey.replaceAll("\n", "\\n")}"`,
].join("\n")
const input = {
  projectId: "customer-project-id",
  webHost: "board.example.com",
  revision: "a".repeat(40),
  credentials,
}
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

/**
 * What the app's settings entrypoint answers (see ./source.ts): the
 * installer's resource prefix for api.board.example.com, the bucket the
 * STORAGE_* settings select, and no refusal.
 */
const app: AppSettings = {
  resourcePrefix: () => "azad-api-board-example-com-7ec551c7",
  storage: (settings) =>
    settings.STORAGE_ADAPTER === "gcs"
      ? {
          kind: "gcs",
          bucket: settings.STORAGE_BUCKET,
          releasesBucket:
            settings.STORAGE_RELEASES_BUCKET || settings.STORAGE_BUCKET,
        }
      : { kind: "r2" },
  validate: () => undefined,
}

/** An instance directory, a credential file and an app source checkout, side by side in a temporary directory. */
function layout(prefix: string, root: "postgres" | "cloudsql" = "postgres") {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  const credentialsFile = join(directory, "credentials.env")
  writeFileSync(credentialsFile, credentials)
  return {
    directory,
    root,
    rootDirectory: join(REPOSITORY, "roots", root),
    credentialsFile,
    source: fakeSource(directory),
    files: instanceTerraform(join(directory, "instance"), root),
  }
}

/** What `init` records: the instance's working data points at its own state. */
function initialized(files: InstanceTerraform) {
  mkdirSync(files.data, { recursive: true })
  writeFileSync(
    join(files.data, "terraform.tfstate"),
    JSON.stringify({
      backend: { type: "local", config: { path: files.state } },
    })
  )
}

/** A `terraform` on PATH that prints what it was run with. */
function echoTerraform(directory: string, body: string) {
  const bin = join(directory, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, "terraform"),
    `#!/usr/bin/env -S bun --no-env-file\n${body}\n`,
    {
      mode: 0o755,
    }
  )
  return bin
}

function driver(args: string[], env: Record<string, string | undefined>) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "cloudflare.ts"),
      ...args,
    ],
    { env, stdout: "pipe", stderr: "pipe" }
  )
}

function boundary(accountIds = ["0".repeat(32)], ip = "198.51.100.10") {
  const calls: string[] = []
  const fetcher = async (
    url: string | URL | Request,
    options?: RequestInit
  ) => {
    const address = String(url)
    calls.push(address)
    if (address.includes("/accounts?")) {
      expect(new Headers(options?.headers).get("Authorization")).toBe(
        "Bearer fake-cf-token"
      )
      return Response.json({
        success: true,
        result: accountIds.map((id) => ({ id })),
      })
    }
    if (address === "https://api.github.com/app") {
      const token =
        new Headers(options?.headers).get("Authorization")?.slice(7) ?? ""
      const [header, body, signature] = token.split(".")
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${body}`),
          publicKey,
          Buffer.from(signature, "base64url")
        )
      ).toBe(true)
      expect(JSON.parse(Buffer.from(body, "base64url").toString()).iss).toBe(
        "12345"
      )
      return Response.json({
        id: 12345,
        slug: "customer-azad",
        client_id: "Iv1.customer",
      })
    }
    if (address.startsWith("https://api.cloudflare.com/client/v4/zones?")) {
      const name = new URL(address).searchParams.get("name")
      return Response.json({
        success: true,
        result:
          name === "example.com"
            ? [{ id: "2".repeat(32), name: "example.com" }]
            : [],
      })
    }
    if (address.endsWith("/ips-v4"))
      return new Response("192.0.2.0/24\n203.0.113.0/24\n")
    if (address.endsWith("/cdn-cgi/trace"))
      return new Response(`fl=example\nip=${ip}\ntls=TLSv1.3\n`)
    throw new Error("Unexpected lookup")
  }
  return { calls, fetcher }
}

test("turns project, hostname and seven credentials into a minimal customer configuration", async () => {
  const api = boundary()
  const result = await prepareCloudflare(input, app, api.fetcher)
  expect<unknown>(result.tfvars).toEqual({
    gcp: {
      project_id: "customer-project-id",
      authorized_networks: {
        "cloudflare-1": "192.0.2.0/24",
        "cloudflare-2": "203.0.113.0/24",
        runner: "198.51.100.10/32",
      },
    },
    cloudflare: {
      account_id: "0".repeat(32),
      api_origin: "https://api.board.example.com",
      web_origin: "https://board.example.com",
    },
    deployment: { revision: "a".repeat(40) },
    // Both Board hosts are reserved from zone-wide Worker routes.
    host_zones: {
      "board.example.com": "2".repeat(32),
      "api.board.example.com": "2".repeat(32),
    },
  })
  const env = parse(result.installerEnv)
  expect(env.GITHUB_APP_PRIVATE_KEY).toBe(privateKey)
  expect(env.GITHUB_APP_SLUG).toBe("customer-azad")
  expect(env.GITHUB_APP_CLIENT_ID).toBe("Iv1.customer")
  expect(env.GITHUB_WEBHOOK_SECRET).toMatch(/^[a-f0-9]{64}$/u)
  expect(env.AZAD_SELF_HOST_MINIAPPS).toBe("disabled")
  expect(JSON.stringify(result.tfvars)).not.toContain("fake-cf-token")
})

test("the app validates the complete derived settings once every lookup is done", async () => {
  const validated: Array<{ target: string; settings: Record<string, string> }> =
    []
  await prepareCloudflare(
    input,
    {
      ...app,
      validate: (target, settings) => {
        validated.push({ target, settings })
      },
    },
    boundary().fetcher
  )
  expect(validated).toHaveLength(1)
  expect(validated[0].target).toBe("cloudflare")
  expect(validated[0].settings).toMatchObject({
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    AZAD_SELF_HOST_API_ORIGIN: "https://api.board.example.com",
    AZAD_SELF_HOST_WEB_ORIGIN: "https://board.example.com",
    GITHUB_APP_SLUG: "customer-azad",
    AZAD_SELF_HOST_MINIAPPS: "disabled",
  })
  // Cloud SQL's DSN comes from Terraform: setup checks a stand-in of its shape.
  expect(validated[0].settings.DATABASE_URL).toContain("sslmode=require")
})

test("a setting the app refuses stops setup with the app's reason", async () => {
  await expect(
    prepareCloudflare(
      input,
      {
        ...app,
        validate: () => {
          throw new SettingsRefused(
            "DATABASE_URL must explicitly set sslmode=require or sslmode=verify-full."
          )
        },
      },
      boundary().fetcher
    )
  ).rejects.toThrow("The settings are not deployable: DATABASE_URL must")
})

test("keeps an existing webhook and derives Mini App account only when its token is supplied", async () => {
  const result = await prepareCloudflare(
    {
      ...input,
      credentials: `${credentials}\nGITHUB_WEBHOOK_SECRET=keep-this\nV3_CF_API_TOKEN=fake-runtime\n`,
      accountId: "1".repeat(32),
      runnerCidr: "203.0.113.42/32",
    },
    app,
    boundary().fetcher
  )
  const env = parse(result.installerEnv)
  expect(result.generatedWebhook).toBe(false)
  expect(env.GITHUB_WEBHOOK_SECRET).toBe("keep-this")
  expect(env.V3_CF_ACCOUNT_ID).toBe("1".repeat(32))
  expect(result.tfvars.gcp?.authorized_networks.runner).toBe("203.0.113.42/32")
})

test("asks for account selection when a token can access multiple accounts", async () => {
  const api = boundary(["0".repeat(32), "1".repeat(32)])
  await expect(prepareCloudflare(input, app, api.fetcher)).rejects.toThrow(
    "--account-id"
  )
  expect(api.calls).toHaveLength(1)
})

test("requires an explicit runner IPv4 when autodetection returns IPv6", async () => {
  await expect(
    prepareCloudflare(input, app, boundary(undefined, "2001:db8::1").fetcher)
  ).rejects.toThrow("--runner-cidr")
})

test("writes the private settings and variables into the instance once, with instance paths", async () => {
  const f = layout("terraform-cloudflare-")
  const result = await prepareCloudflare(input, app, boundary().fetcher)
  saveCloudflare(f.files, result, f.credentialsFile)
  expect(statSync(f.files.settings).mode & 0o777).toBe(0o600)
  expect(readFileSync(f.files.settings, "utf8")).toBe(result.installerEnv)
  expect(JSON.parse(readFileSync(f.files.vars, "utf8")).deployment).toEqual({
    revision: input.revision,
    env_file: f.files.settings,
    state_directory: join(f.files.directory, "installer-state"),
  })
  expect(() =>
    saveCloudflare(
      f.files,
      { ...result, installerEnv: "replacement" },
      f.credentialsFile
    )
  ).toThrow("already exists")
  expect(readFileSync(f.files.settings, "utf8")).toBe(result.installerEnv)
})

test("setup adds its derived settings to the instance's own settings file and never replaces another one", async () => {
  const f = layout("terraform-cloudflare-installer-")
  mkdirSync(f.files.instance)
  writeFileSync(
    f.files.settings,
    `# the installer's answers\nAZAD_CLI_WEB_HOST=board.example.com\n${credentials}\n`,
    { mode: 0o600 }
  )
  const result = await prepareCloudflare(input, app, boundary().fetcher)
  saveCloudflare(f.files, result, f.files.settings)
  const text = readFileSync(f.files.settings, "utf8")
  expect(text.startsWith("# the installer's answers\n")).toBe(true)
  const saved = parse(text)
  expect(saved.AZAD_CLI_WEB_HOST).toBe("board.example.com")
  expect(saved.GITHUB_APP_PRIVATE_KEY).toBe(privateKey)
  expect(saved.GITHUB_APP_SLUG).toBe("customer-azad")
  expect(saved.GITHUB_WEBHOOK_SECRET).toMatch(/^[a-f0-9]{64}$/u)

  const other = layout("terraform-cloudflare-other-")
  mkdirSync(other.files.instance)
  writeFileSync(other.files.settings, "KEEP=this\n")
  expect(() =>
    saveCloudflare(other.files, result, other.credentialsFile)
  ).toThrow("already exists")
  expect(readFileSync(other.files.settings, "utf8")).toBe("KEEP=this\n")
  expect(existsSync(other.files.vars)).toBe(false)
})

test("forwards a saved-plan command with the selected token, the instance's variables, working data and the source checkout", async () => {
  const f = layout("terraform-cloudflare-command-")
  const result = await prepareCloudflare(input, app, boundary().fetcher)
  saveCloudflare(f.files, result, f.credentialsFile)
  initialized(f.files)
  const bin = echoTerraform(
    f.directory,
    "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), token: process.env.CLOUDFLARE_API_TOKEN, data: process.env.TF_DATA_DIR, source: process.env.TF_VAR_source_dir, uninstallSource: process.env.AZAD_SOURCE }))"
  )
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    CLOUDFLARE_API_TOKEN: "wrong-ambient-token",
  }
  const plan = driver(
    [
      "plan",
      "--root",
      f.root,
      "-out=terraform.tfplan",
      "--source",
      f.source.path,
      "--instance-dir",
      f.files.instance,
    ],
    env
  )
  expect(plan.stderr.toString()).toBe("")
  expect(plan.exitCode).toBe(0)
  expect(JSON.parse(plan.stdout.toString())).toEqual({
    args: [
      `-chdir=${f.rootDirectory}`,
      "plan",
      `-var-file=${f.files.vars}`,
      `-out=${join(f.files.directory, "terraform.tfplan")}`,
    ],
    token: "fake-cf-token",
    data: f.files.data,
    source: f.source.path,
    uninstallSource: f.source.path,
  })
  // AZAD_SOURCE stands in for --source.
  const apply = driver(
    [
      "apply",
      "terraform.tfplan",
      "--root",
      f.root,
      "--instance-dir",
      f.files.instance,
    ],
    { ...env, AZAD_SOURCE: f.source.path }
  )
  expect(JSON.parse(apply.stdout.toString()).args).toEqual([
    `-chdir=${f.rootDirectory}`,
    "apply",
    join(f.files.directory, "terraform.tfplan"),
  ])
  expect(JSON.parse(apply.stdout.toString()).source).toBe(f.source.path)
})

test("commands that deploy or uninstall need a valid app source checkout; state readers do not", async () => {
  const f = layout("terraform-cloudflare-source-")
  const result = await prepareCloudflare(input, app, boundary().fetcher)
  saveCloudflare(f.files, result, f.credentialsFile)
  initialized(f.files)
  const bin = echoTerraform(
    f.directory,
    "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), source: process.env.TF_VAR_source_dir ?? null }))"
  )
  const env = { PATH: `${bin}:${process.env.PATH}` }
  const run = (command: string, ...extra: string[]) =>
    driver(
      [command, "--root", f.root, "--instance-dir", f.files.instance, ...extra],
      env
    )
  for (const command of ["plan", "apply", "destroy", "refresh"]) {
    const missing = run(command)
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr.toString()).toContain("--source is required")
    expect(missing.stdout.toString()).toBe("")
  }
  const nowhere = run("plan", "--source", join(f.directory, "missing"))
  expect(nowhere.stderr.toString()).toContain("does not exist")
  const plain = join(f.directory, "plain")
  mkdirSync(plain)
  expect(run("plan", "--source", plain).stderr.toString()).toContain(
    "is not a Git checkout"
  )
  rmSync(join(f.source.path, "scripts/self-host/celld-install.ts"))
  expect(run("plan", "--source", f.source.path).stderr.toString()).toContain(
    "lacks scripts/self-host/celld-install.ts"
  )
  for (const command of ["output", "show", "state"]) {
    const reader = run(command)
    expect(reader.exitCode).toBe(0)
    expect(JSON.parse(reader.stdout.toString()).source).toBeNull()
  }
})

test("--root takes a root name, never a path", () => {
  const f = layout("terraform-cloudflare-root-")
  const child = driver(
    [
      "output",
      "--root",
      join(REPOSITORY, "roots/postgres"),
      "--instance-dir",
      f.files.instance,
    ],
    { PATH: process.env.PATH }
  )
  expect(child.exitCode).toBe(1)
  expect(child.stderr.toString()).toContain(
    "--root takes a root name: cloudsql or postgres"
  )
})

test("init points the backend and working data at the instance; other commands wait for it", async () => {
  const f = layout("terraform-cloudflare-init-")
  const result = await prepareCloudflare(input, app, boundary().fetcher)
  saveCloudflare(f.files, result, f.credentialsFile)
  const bin = echoTerraform(
    f.directory,
    "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), data: process.env.TF_DATA_DIR }))"
  )
  const env = { PATH: `${bin}:${process.env.PATH}` }
  const before = driver(
    ["output", "--root", f.root, "--instance-dir", f.files.instance],
    env
  )
  expect(before.exitCode).toBe(1)
  expect(before.stderr.toString()).toContain("init --root postgres")
  const init = driver(
    ["init", "--root", f.root, "--instance-dir", f.files.instance],
    env
  )
  expect(JSON.parse(init.stdout.toString())).toEqual({
    args: [
      `-chdir=${f.rootDirectory}`,
      "init",
      "-reconfigure",
      `-backend-config=path=${f.files.state}`,
      `-backend-config=workspace_dir=${f.files.workspaces}`,
    ],
    data: f.files.data,
  })
})

test("reports failed account lookups without echoing provider response bodies", async () => {
  const fetcher = () =>
    Promise.resolve(
      new Response("sensitive-provider-diagnostic", { status: 403 })
    )
  await expect(prepareCloudflare(input, app, fetcher)).rejects.toThrow(
    "api.cloudflare.com (HTTP 403)"
  )
})

test("refresh binds the instance to the source checkout's HEAD and preserves credentials and overrides", async () => {
  const f = layout("terraform-cloudflare-refresh-")
  const result = await prepareCloudflare(input, app, boundary().fetcher)
  saveCloudflare(f.files, result, f.credentialsFile)
  const overridden = {
    ...JSON.parse(readFileSync(f.files.vars, "utf8")),
    gcp: {
      ...result.tfvars.gcp,
      region: "europe-west1",
      tier: "db-custom-4-15360",
    },
  }
  writeFileSync(f.files.vars, JSON.stringify(overridden))
  const child = driver(
    [
      "refresh",
      "--root",
      f.root,
      "--source",
      f.source.path,
      "--instance-dir",
      f.files.instance,
    ],
    { PATH: process.env.PATH }
  )
  expect(child.exitCode).toBe(0)
  const updated = JSON.parse(readFileSync(f.files.vars, "utf8"))
  expect(updated.deployment.revision).toBe(f.source.revision)
  updated.deployment.revision = input.revision
  expect(updated).toEqual(overridden)
  expect(readFileSync(f.files.settings, "utf8")).toBe(result.installerEnv)
})

test("requires direct PostgreSQL egress instead of detecting an HTTP proxy address", async () => {
  const api = boundary()
  await expect(
    prepareCloudflare({ ...input, httpProxyConfigured: true }, app, api.fetcher)
  ).rejects.toThrow("direct PostgreSQL TCP egress")
  expect(api.calls).toHaveLength(0)
  const result = await prepareCloudflare(
    { ...input, httpProxyConfigured: true, runnerCidr: "203.0.113.42/32" },
    app,
    api.fetcher
  )
  expect(result.tfvars.gcp?.authorized_networks.runner).toBe("203.0.113.42/32")
  expect(api.calls).not.toContain("https://www.cloudflare.com/cdn-cgi/trace")
})

test("CLI detects proxy environment before network lookup or output writes", () => {
  const f = layout("terraform-cloudflare-proxy-", "cloudsql")
  const child = driver(
    [
      "setup",
      "--database-provider",
      "cloudsql",
      "--project-id",
      input.projectId,
      "--web-host",
      input.webHost,
      "--credentials",
      f.credentialsFile,
      "--root",
      f.root,
      "--source",
      f.source.path,
      "--instance-dir",
      f.files.instance,
    ],
    { PATH: process.env.PATH, HTTPS_PROXY: "http://proxy.invalid:8080" }
  )
  expect(child.exitCode).toBe(1)
  expect(child.stderr.toString()).toContain("--runner-cidr")
  expect(child.stderr.toString()).not.toContain("fake-cf-token")
  expect(existsSync(f.files.instance)).toBe(false)
})

test("CLI setup refuses a root that does not match the database provider", () => {
  const f = layout("terraform-cloudflare-provider-", "cloudsql")
  const child = driver(
    [
      "setup",
      "--database-provider",
      "postgres",
      "--web-host",
      input.webHost,
      "--credentials",
      f.credentialsFile,
      "--source",
      f.source.path,
      "--instance-dir",
      f.files.instance,
    ],
    { PATH: process.env.PATH }
  )
  expect(child.exitCode).toBe(1)
  expect(child.stderr.toString()).toContain("--root postgres")
  expect(existsSync(f.files.instance)).toBe(false)
})

test("distinguishes network and remote metadata failures from credential formats", async () => {
  const network = () =>
    Promise.reject(new Error("ENOTFOUND with private details"))
  await expect(prepareCloudflare(input, app, network)).rejects.toThrow(
    "Check network/proxy settings"
  )
  const metadata = () =>
    Promise.resolve(Response.json({ unexpected: "private provider detail" }))
  await expect(prepareCloudflare(input, app, metadata)).rejects.toThrow(
    "unexpected account metadata"
  )
  const api = boundary()
  const ranges = (url: string | URL | Request, options?: RequestInit) =>
    String(url).endsWith("/ips-v4")
      ? Promise.resolve(new Response("invalid-range"))
      : api.fetcher(url, options)
  await expect(prepareCloudflare(input, app, ranges)).rejects.toThrow(
    "invalid published IPv4 range"
  )
})

test("supplied Postgres needs no GCP or IP discovery and keeps its DSN out of tfvars", async () => {
  const api = boundary()
  const dsn =
    "postgresql://azad:private-password@db.example.com:5432/azad?sslmode=verify-full"
  const validated: Array<Record<string, string>> = []
  const result = await prepareCloudflare(
    {
      ...input,
      projectId: undefined,
      databaseProvider: "postgres",
      httpProxyConfigured: true,
      credentials: `${credentials}\nDATABASE_URL=${dsn}\nAZAD_SELF_HOST_DATABASE_CA_CERT_ID=example-ca`,
    },
    {
      ...app,
      validate: (_, settings) => {
        validated.push(settings)
      },
    },
    api.fetcher
  )
  expect(result.tfvars.gcp).toBeUndefined()
  expect(result.tfvars).not.toHaveProperty("database_url")
  expect(api.calls).not.toContain("https://www.cloudflare.com/ips-v4")
  expect(api.calls).not.toContain("https://www.cloudflare.com/cdn-cgi/trace")
  expect(JSON.stringify(result.tfvars)).not.toContain("private-password")
  expect(parse(result.installerEnv).DATABASE_URL).toBe(dsn)
  // The app checks the supplied DSN itself.
  expect(validated[0].DATABASE_URL).toBe(dsn)
})

test("supplied Postgres refuses missing credentials before provider lookup", async () => {
  const api = boundary()
  await expect(
    prepareCloudflare(
      { ...input, databaseProvider: "postgres" },
      app,
      api.fetcher
    )
  ).rejects.toThrow("DATABASE_URL")
  expect(api.calls).toHaveLength(0)
})

test("prepares automatic Neon CA registration without asking for an ID or making certificate writes", async () => {
  const api = boundary()
  const result = await prepareCloudflare(
    {
      ...input,
      databaseProvider: "postgres",
      credentials:
        credentials +
        "\nDATABASE_URL=postgresql://azad:fake@ep-test.us-east-2.aws.neon.tech/azad?sslmode=verify-full\nAZAD_SELF_HOST_DATABASE_CA=neon-isrg-root-x1\n",
    },
    app,
    api.fetcher
  )
  expect(result.tfvars.database_ca).toBe("neon-isrg-root-x1")
  expect(result.installerEnv).not.toContain(
    "AZAD_SELF_HOST_DATABASE_CA_CERT_ID"
  )
  // Only reads: account and App identity, and the hosts' zones.
  expect(api.calls.filter((call) => !call.includes("/zones?"))).toEqual([
    "https://api.cloudflare.com/client/v4/accounts?per_page=50",
    "https://api.github.com/app",
  ])
})

test("the actual Cloudflare runner supplies the OS-trusted public CA to a saved-plan invocation", async () => {
  const f = layout("terraform-cloudflare-ca-command-")
  const result = await prepareCloudflare(
    {
      ...input,
      databaseProvider: "postgres",
      credentials:
        credentials +
        "\nDATABASE_URL=postgresql://azad:fake@ep-test.us-east-2.aws.neon.tech/azad?sslmode=verify-full\nAZAD_SELF_HOST_DATABASE_CA=neon-isrg-root-x1\n",
    },
    app,
    boundary().fetcher
  )
  saveCloudflare(f.files, result, f.credentialsFile)
  initialized(f.files)
  const bin = echoTerraform(
    f.directory,
    "import {X509Certificate} from 'node:crypto'; process.stdout.write(JSON.stringify({args:process.argv.slice(2),fingerprint:new X509Certificate(process.env.TF_VAR_database_ca_pem).fingerprint256}));"
  )
  const child = driver(
    [
      "plan",
      "--root",
      f.root,
      "--source",
      f.source.path,
      "--instance-dir",
      f.files.instance,
      "-out=terraform.tfplan",
    ],
    { PATH: `${bin}:${process.env.PATH}` }
  )
  expect(child.exitCode).toBe(0)
  expect(JSON.parse(child.stdout.toString())).toEqual({
    args: [
      `-chdir=${f.rootDirectory}`,
      "plan",
      `-var-file=${f.files.vars}`,
      `-out=${join(f.files.directory, "terraform.tfplan")}`,
    ],
    fingerprint:
      "96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6",
  })
  expect(readFileSync(f.files.settings, "utf8")).not.toContain(
    "AZAD_SELF_HOST_DATABASE_CA_CERT_ID"
  )
})

function dnsBoundary(
  existing: Record<string, { type: string; content: string }>
) {
  const fetcher = async (
    url: string | URL | Request,
    options?: RequestInit
  ) => {
    const address = new URL(String(url))
    const auth = new Headers(options?.headers).get("Authorization")
    if (address.href === "https://api.clerk.com/v1/domains") {
      expect(auth).toBe("Bearer sk_live_fake")
      return Response.json({
        data: [
          {
            name: "board.example.com",
            is_satellite: false,
            cname_targets: [
              {
                host: "clerk.board.example.com",
                value: "frontend-api.clerk.services",
                required: true,
              },
              {
                host: "clk._domainkey.board.example.com",
                value: "dkim1.abc.clerk.services.",
                required: true,
              },
            ],
          },
        ],
      })
    }
    expect(auth).toBe("Bearer fake-cf-token")
    if (address.pathname.endsWith("/zones")) {
      expect(address.searchParams.get("account.id")).toBe("0".repeat(32))
      return Response.json({
        success: true,
        result:
          address.searchParams.get("name") === "example.com"
            ? [{ id: "1".repeat(32), name: "example.com" }]
            : [],
      })
    }
    if (address.pathname.endsWith("/dns_records")) {
      const record = existing[address.searchParams.get("name") ?? ""]
      return Response.json({ success: true, result: record ? [record] : [] })
    }
    throw new Error("Unexpected lookup")
  }
  return fetcher
}

test("a production Clerk key yields the CNAMEs Terraform creates, skipping matching records", async () => {
  const result = await clerkDns(
    dnsBoundary({
      "clerk.board.example.com": {
        type: "CNAME",
        content: "frontend-api.clerk.services",
      },
    }),
    "sk_live_fake",
    "fake-cf-token",
    "0".repeat(32)
  )
  expect(result).toEqual({
    zone_id: "1".repeat(32),
    zone: "example.com",
    records: {
      "clk._domainkey.board.example.com": "dkim1.abc.clerk.services",
    },
  })
})

test("a conflicting Clerk DNS record stops setup instead of failing during apply", async () => {
  await expect(
    clerkDns(
      dnsBoundary({
        "clerk.board.example.com": { type: "A", content: "192.0.2.1" },
      }),
      "sk_live_fake",
      "fake-cf-token",
      "0".repeat(32)
    )
  ).rejects.toThrow("different record for clerk.board.example.com")
})

test("development Clerk keys need no DNS and make no Clerk request", async () => {
  expect(
    await clerkDns(
      async () => {
        throw new Error("No request expected")
      },
      "sk_test_fake",
      "fake-cf-token",
      "0".repeat(32)
    )
  ).toBeUndefined()
})

test("an operator-owned bucket becomes Terraform's storage choice while its keys stay private", async () => {
  const result = await prepareCloudflare(
    {
      ...input,
      projectId: undefined,
      databaseProvider: "postgres",
      credentials: `${credentials}\nDATABASE_URL=postgresql://azad:fake@db.example.com:5432/azad?sslmode=require\nSTORAGE_ADAPTER=gcs\nSTORAGE_BUCKET=customer-azad-files\nSTORAGE_ACCESS_KEY_ID=GOOG1EXAMPLE\nSTORAGE_SECRET_ACCESS_KEY=fake-hmac-secret\n`,
    },
    app,
    boundary().fetcher
  )
  expect(result.tfvars.storage).toEqual({
    adapter: "gcs",
    bucket: "customer-azad-files",
    releases_bucket: undefined,
    endpoint: undefined,
    region: undefined,
  })
  expect(JSON.stringify(result.tfvars)).not.toContain("fake-hmac-secret")
  expect(parse(result.installerEnv).STORAGE_SECRET_ACCESS_KEY).toBe(
    "fake-hmac-secret"
  )
})

test("STORAGE_* settings the app refuses stop setup with its reason", async () => {
  await expect(
    prepareCloudflare(
      input,
      {
        ...app,
        storage: () => {
          throw new SettingsRefused("STORAGE_ADAPTER must be r2, s3 or gcs.")
        },
      },
      boundary().fetcher
    )
  ).rejects.toThrow("STORAGE_ADAPTER must be r2, s3 or gcs.")
})

test("a pending GitHub App is never looked up and needs its placeholders", async () => {
  const api = boundary()
  const pending = `${credentials}\nAZAD_SELF_HOST_GITHUB_APP_PENDING=1\n`
  await expect(
    prepareCloudflare({ ...input, credentials: pending }, app, api.fetcher)
  ).rejects.toThrow("placeholder GITHUB_APP_SLUG and GITHUB_APP_CLIENT_ID")
  const result = await prepareCloudflare(
    {
      ...input,
      credentials: `${pending}GITHUB_APP_SLUG=azad-pending\nGITHUB_APP_CLIENT_ID=Iv1.pending\n`,
    },
    app,
    api.fetcher
  )
  expect(api.calls).not.toContain("https://api.github.com/app")
  expect(result.tfvars.github_app_pending).toBe(true)
  expect(parse(result.installerEnv).GITHUB_APP_SLUG).toBe("azad-pending")
})

test("managed project source gets this installation's own Artifacts namespace", async () => {
  const origins: string[] = []
  const result = await prepareCloudflare(
    {
      ...input,
      credentials: `${credentials}\nCLOUDFLARE_ARTIFACTS_API_TOKEN=fake-artifacts\nCLOUDFLARE_ARTIFACTS_EVENTS_API_TOKEN=fake-events\nV3_CONTROL_BACKUP_GITHUB_REPO=customer/control-backup\n`,
    },
    {
      ...app,
      resourcePrefix: (origin) => {
        origins.push(origin)
        return app.resourcePrefix(origin)
      },
    },
    boundary().fetcher
  )
  const env = parse(result.installerEnv)
  expect(origins).toEqual(["https://api.board.example.com"])
  expect(env.V3_CF_ARTIFACTS_NAMESPACE).toBe(
    "azad-api-board-example-com-7ec551c7-control"
  )
  expect(env.V3_CF_ACCOUNT_ID).toBe("0".repeat(32))
})
