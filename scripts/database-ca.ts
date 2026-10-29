/**
 * Neon's public root for Cloudflare's database CA registration
 * (modules/cloudflare/resources, `database_ca = "neon-isrg-root-x1"`): taken
 * from this machine's OS trust store at plan, apply and destroy time, never
 * downloaded or bundled.
 */
import { spawnSync } from "node:child_process"
import { X509Certificate } from "node:crypto"
import { getCACertificates } from "node:tls"

/** The only `database_ca` selection the Postgres root supports. */
export const NEON_DATABASE_CA = "neon-isrg-root-x1"
const fingerprint =
  "96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6"
const subject = "C=US\nO=Internet Security Research Group\nCN=ISRG Root X1"

const macosSystemRoots =
  "/System/Library/Keychains/SystemRootCertificates.keychain"

/** Reads the operating system's trusted roots. Node and Bun return only
 * user/admin trust-settings certificates for "system" on macOS, so the built-in
 * Apple root store is read from its keychain with the OS `security` tool.
 */
export function systemTrustedCertificates(
  platform: NodeJS.Platform = process.platform
): string[] {
  const certificates = [...getCACertificates("system")]
  if (platform !== "darwin") return certificates
  const roots = spawnSync(
    "/usr/bin/security",
    ["find-certificate", "-a", "-p", macosSystemRoots],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  )
  if (roots.status !== 0) return certificates
  return [
    ...certificates,
    ...(roots.stdout.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu
    ) ?? []),
  ]
}

/** Selects Neon's documented public root from the OS-managed trust store.
 * No certificate bundle, remote download, peer-chain trust or private key.
 * An absent/ambiguous root is not silently added to the machine's trust policy.
 */
export function neonCaPem(
  trustedCertificates: readonly string[] = systemTrustedCertificates()
): string {
  const matches = new Map<string, X509Certificate>()
  for (const pem of trustedCertificates) {
    const certificate = new X509Certificate(pem)
    if (
      certificate.subject !== subject ||
      certificate.fingerprint256 !== fingerprint ||
      !certificate.ca ||
      certificate.issuer !== certificate.subject ||
      !certificate.verify(certificate.publicKey)
    )
      continue
    if (
      Date.parse(certificate.validFrom) > Date.now() ||
      Date.parse(certificate.validTo) <= Date.now()
    )
      continue
    matches.set(certificate.fingerprint256, certificate)
  }
  if (matches.size !== 1)
    throw new Error(
      "The OS trust store must contain one valid ISRG Root X1 root for automatic Neon CA registration. Check the machine's trusted certificate store; no trust was added."
    )
  return [...matches.values()][0].toString()
}
