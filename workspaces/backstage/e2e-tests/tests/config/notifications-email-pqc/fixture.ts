/**
 * Shared constants for the notifications email PQC suite.
 *
 * Mailpit offers SMTP STARTTLS. The hub runs openssl s_client against that
 * Service and checks the negotiated group. The private key stays in the
 * Mailpit Secret.
 */
export const CONFIG_DIR = "tests/config/notifications-email-pqc";
export const MAILPIT_TLS_SECRET_NAME = "mailpit-tls";
export const MAILPIT_SMTP_PORT = 1025;

export function mailpitSmtpHost(namespace: string): string {
  return `mailpit.${namespace}.svc`;
}
