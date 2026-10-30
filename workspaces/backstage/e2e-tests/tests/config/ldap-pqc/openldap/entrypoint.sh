#!/usr/bin/env bash
# Minimal slapd entrypoint for RHDH LDAP PQC e2e (UBI 10.2 / OpenSSL TLS).
set -euo pipefail

export PATH="/opt/openldap/libexec:/opt/openldap/sbin:/opt/openldap/bin:${PATH}"
SLAPD=/opt/openldap/libexec/slapd

: "${LDAP_ROOT:=dc=rhdh,dc=test}"
: "${LDAP_ADMIN_USERNAME:=admin}"
: "${LDAP_ADMIN_PASSWORD:=user1pass}"
: "${LDAP_PORT_NUMBER:=1389}"
: "${LDAP_LDAPS_PORT_NUMBER:=1636}"
: "${LDAP_ENABLE_TLS:=no}"
: "${LDAP_SEED_FILE:=/ldifs/seed.ldif}"
: "${LDAP_TLS_CERT_FILE:=/certs/tls.crt}"
: "${LDAP_TLS_KEY_FILE:=/certs/tls.key}"
: "${LDAP_TLS_CA_FILE:=/certs/ca.crt}"

CONF_DIR=/opt/openldap/etc/openldap
CONF_FILE="${CONF_DIR}/slapd.conf"
DATA_DIR=/var/lib/ldap
RUN_DIR=/opt/openldap/var/run

mkdir -p "${DATA_DIR}" "${RUN_DIR}"

sed \
  -e "s|__LDAP_ROOT__|${LDAP_ROOT}|g" \
  -e "s|__LDAP_ADMIN_USERNAME__|${LDAP_ADMIN_USERNAME}|g" \
  -e "s|__LDAP_ADMIN_PASSWORD__|${LDAP_ADMIN_PASSWORD}|g" \
  "${CONF_DIR}/slapd.conf.template" >"${CONF_FILE}"

if [[ "${LDAP_ENABLE_TLS}" == "yes" || "${LDAP_ENABLE_TLS}" == "true" ]]; then
  for f in "${LDAP_TLS_CERT_FILE}" "${LDAP_TLS_KEY_FILE}" "${LDAP_TLS_CA_FILE}"; do
    if [[ ! -f "${f}" ]]; then
      echo "[openldap-pq] TLS enabled but missing ${f}" >&2
      exit 1
    fi
  done
  cat >>"${CONF_FILE}" <<EOF

TLSCertificateFile      ${LDAP_TLS_CERT_FILE}
TLSCertificateKeyFile   ${LDAP_TLS_KEY_FILE}
TLSCACertificateFile    ${LDAP_TLS_CA_FILE}
TLSVerifyClient         never
EOF
fi

# First boot: load seed into the MDB via slapadd (slapd must be stopped).
if [[ ! -f "${DATA_DIR}/data.mdb" ]]; then
  echo "[openldap-pq] initializing MDB from ${LDAP_SEED_FILE}"
  if [[ ! -f "${LDAP_SEED_FILE}" ]]; then
    echo "[openldap-pq] seed file not found: ${LDAP_SEED_FILE}" >&2
    exit 1
  fi
  slapadd -f "${CONF_FILE}" -l "${LDAP_SEED_FILE}"
fi

LISTEN="ldap://:${LDAP_PORT_NUMBER}"
if [[ "${LDAP_ENABLE_TLS}" == "yes" || "${LDAP_ENABLE_TLS}" == "true" ]]; then
  LISTEN="${LISTEN} ldaps://:${LDAP_LDAPS_PORT_NUMBER}"
fi

echo "[openldap-pq] openssl=$(openssl version)"
echo "[openldap-pq] starting slapd on ${LISTEN} (OPENSSL_CONF=${OPENSSL_CONF:-unset})"
# -d keeps slapd in the foreground (required for containers). Keep the level
# low — high debug (e.g. 256) OOMs under OpenLDAPHelper's 512Mi memory limit.
exec "${SLAPD}" -f "${CONF_FILE}" -h "${LISTEN}" -d 1
