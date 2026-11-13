/**
 * Shared constants for the OpenSSL PQC HTTPS suite.
 *
 * Deploys ubi10/httpd-24 with TLS on 8443 (image auto-generates a self-signed
 * cert), then runs openssl s_client from the RHDH hub container against the
 * in-cluster Service DNS — east-west to the pod's own OpenSSL stack, not an
 * OpenShift Route.
 */
export const CONFIG_DIR = "tests/config/openssl-pqc";

export const PQ_HTTPD_NAME = "pq-httpd";

/** HTTPS listen port inside ubi10/httpd-24 (EXPOSE 8443). */
export const PQ_HTTPD_HTTPS_PORT = 8443;

export const TLS_GROUPS = {
  classical: "X25519",
  hybrid: "X25519MLKEM768",
} as const;

export type TlsGroup = (typeof TLS_GROUPS)[keyof typeof TLS_GROUPS];
