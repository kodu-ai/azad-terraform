import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "dotenv"
import {
  forwardedArgs,
  instanceTerraform,
  REPOSITORY,
  rootNamed,
  terraformArguments,
  upsertSettings,
} from "./instance"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

test("Terraform arguments use the instance's backend, variables and plan files", () => {
  const files = instanceTerraform("/instance", "cloudsql")
  expect(files.directory).toBe("/instance/terraform/cloudsql")
  expect(files.root).toBe(join(REPOSITORY, "roots/cloudsql"))
  expect(terraformArguments("plan", ["-out=next.tfplan"], files)).toEqual([
    "-var-file=/instance/terraform/cloudsql/terraform.tfvars.json",
    "-out=/instance/terraform/cloudsql/next.tfplan",
  ])
  expect(
    terraformArguments("apply", ["-input=false", "next.tfplan"], files)
  ).toEqual(["-input=false", "/instance/terraform/cloudsql/next.tfplan"])
  expect(
    terraformArguments(
      "apply",
      ["-target", "module.gke", "-auto-approve"],
      files
    )
  ).toEqual([
    "-var-file=/instance/terraform/cloudsql/terraform.tfvars.json",
    "-target",
    "module.gke",
    "-auto-approve",
  ])
  expect(terraformArguments("output", ["-raw", "key"], files)).toEqual([
    "-raw",
    "key",
  ])
})

test("roots are chosen by name, so state never pairs with another configuration", () => {
  expect(rootNamed("postgres", ["cloudsql", "postgres"])).toBe("postgres")
  for (const value of ["roots/postgres", "../postgres", "gcp-celld"])
    expect(() => rootNamed(value, ["cloudsql", "postgres"])).toThrow(
      "--root takes a root name: cloudsql or postgres"
    )
})

test("the drivers' own options never reach Terraform", () => {
  expect(
    forwardedArgs([
      "-out=x.tfplan",
      "--root",
      "postgres",
      "--source=/opt/azad",
      "--instance-dir",
      "/instance",
      "--source",
      "/opt/azad",
      "-input=false",
    ])
  ).toEqual(["-out=x.tfplan", "-input=false"])
})

test("updating a settings file keeps every other line, comment and multi-line value as written", () => {
  const directory = mkdtempSync(join(tmpdir(), "terraform-instance-env-"))
  directories.push(directory)
  const path = join(directory, ".env")
  const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----"
  const original = `# private\nKEY="${pem}"\nSLUG=old\nKEEP=1\n`
  writeFileSync(path, original, { mode: 0o600 })
  upsertSettings(path, { SLUG: "new", ADDED: "value with spaces" })
  const text = readFileSync(path, "utf8")
  expect(text.startsWith(`# private\nKEY="${pem}"\n`)).toBe(true)
  expect(parse(text)).toEqual({
    KEY: pem,
    SLUG: "new",
    KEEP: "1",
    ADDED: "value with spaces",
  })
})
