/**
 * Shared constants for the OpenSSL PQC HTTPS suite.
 *
 * Deploys ubi10/httpd-24, exposes it via an OpenShift edge Route, then runs
 * openssl s_client from the RHDH hub container against that Route hostname
 * (north-south), not the in-cluster Service DNS.
 */
export const CONFIG_DIR = "tests/config/openssl-pqc";

export const PQ_HTTPD_NAME = "pq-httpd";

export const TLS_GROUPS = {
  classical: "X25519",
  hybrid: "X25519MLKEM768",
  pqOnly: "MLKEM768",
} as const;

export type TlsGroup = (typeof TLS_GROUPS)[keyof typeof TLS_GROUPS];
