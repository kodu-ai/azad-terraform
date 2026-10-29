import { expect, test } from "bun:test"
import { checksumLine, releaseNames } from "./release"

test("assets are named after package.json's version and its v-prefixed tag", () => {
  expect(releaseNames("0.0.1")).toEqual({
    tag: "v0.0.1",
    directory: "azad-terraform-0.0.1",
    archive: "azad-terraform-0.0.1.tar.gz",
    checksum: "azad-terraform-0.0.1.tar.gz.sha256",
  })
  expect(() => releaseNames("next")).toThrow("not a semantic version")
})

test("the checksum file is one sha256sum line naming the archive", () => {
  // sha256("") from `printf '' | sha256sum`.
  expect(
    checksumLine(new Uint8Array(), "/out/azad-terraform-0.0.1.tar.gz")
  ).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  azad-terraform-0.0.1.tar.gz\n"
  )
})
