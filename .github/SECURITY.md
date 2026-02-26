# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.8.x (beta) | ✅ Active development |
| < 0.8.0 | ❌ Not supported |

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities as public GitHub issues.**

We use GitHub's private security advisory feature. To report a vulnerability:

1. Go to [Security Advisories](../../security/advisories/new)
2. Click "Report a vulnerability"
3. Fill in the details

Alternatively, email: **security@mcpambassador.dev**

### What to Include

- Description of the vulnerability and potential impact
- Steps to reproduce
- Any proof-of-concept code (treated as confidential)
- Your preferred disclosure timeline

### Our Commitment

- We will acknowledge receipt within **48 hours**
- We will provide an initial assessment within **7 days**
- We will work with you on a coordinated disclosure timeline
- We will credit you in the security advisory (unless you prefer anonymity)

### Scope

In scope:
- Authentication bypass or privilege escalation
- Credential exposure or extraction
- Remote code execution
- SQL injection or command injection
- TLS/cryptography weaknesses
- Docker container escape

Out of scope:
- Denial of service against self-hosted instances (no SLA commitment for self-hosted)
- Rate limiting on development deployments
- Social engineering

## Security Best Practices for Self-Hosters

See the [Security Guide](https://docs.mcpambassador.dev/security) for hardening recommendations.
