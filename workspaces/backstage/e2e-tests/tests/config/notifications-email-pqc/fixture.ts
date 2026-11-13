/**
 * Shared constants for the notifications email PQC (forced ML-KEM) suite.
 *
 * SMTP to in-namespace Mailpit uses STARTTLS. The hub trusts the test CA via
 * NODE_EXTRA_CA_CERTS. The private key stays in the Mailpit Secret.
 */
export const CONFIG_DIR = "tests/config/notifications-email-pqc";
export const OPENSSL_CONFIGMAP_NAME = "openssl-pq";
export const OPENSSL_CNF_KEY = "openssl-pq.cnf";
export const CA_CERT_KEY = "ca.crt";
export const MAILPIT_TLS_SECRET_NAME = "mailpit-tls";

export const SENDER_EMAIL = "backstage-e2e@example.com";
export const RECIPIENT_EMAIL = "pqc-recipient@example.com";

export function mailpitSmtpHost(namespace: string): string {
  return `mailpit.${namespace}.svc.cluster.local`;
}
