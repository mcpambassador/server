# Container Security Hardening - MCP Ambassador Server

**Status**: ✅ Implemented  
**Milestone**: M7.3  
**Date**: 2026-02-17

## Overview

The MCP Ambassador Server Docker container implements defense-in-depth security hardening following OWASP Container Security best practices and CIS Docker Benchmark guidelines.

## Hardening Measures

### 1. Non-Root User Execution

**Implementation**: Dockerfile lines 62-64
```dockerfile
RUN addgroup -g 1000 mcpambassador && \
    adduser -D -u 1000 -G mcpambassador mcpambassador
USER mcpambassador
```

**Rationale**: 
- Prevents privilege escalation attacks
- Limits blast radius if container is compromised
- Follows principle of least privilege

**Runtime Enforcement**: User `mcpambassador` (UID 1000) owns all runtime files

### 2. Read-Only Root Filesystem

**Implementation**: docker-compose.yml line 58
```yaml
read_only: true
```

**Writable Exceptions**:
- `/data` - Persistent volume (database, certs, audit logs)
- `/tmp` - Temporary directory (tmpfs, 64MB limit)

**Rationale**:
- Prevents malware persistence on filesystem
- Immutable infrastructure principle
- Forces all persistent data to designated volume

**Runtime Enforcement**: Container root filesystem mounted read-only, only `/data` and `/tmp` are writable

### 3. Minimal Attack Surface

**Implementation**: Multi-stage build (Dockerfile stages 1-2)

**Builder Stage**:
- Contains build tools, TypeScript compiler, dev dependencies
- Discarded after compilation

**Runtime Stage**:
- Only production dependencies
- Alpine Linux base (minimal packages)
- Single OpenSSL package for TLS generation

**Rationale**:
- Reduces available tools for attacker post-compromise
- Smaller image size (faster deployment, less storage)
- Fewer CVE exposure points

**Package Count**: Alpine base + Node.js + OpenSSL only (~50MB final image)

### 4. Explicit Security Options

**Implementation**: docker-compose.yml lines 54-56
```yaml
security_opt:
  - no-new-privileges:true
```

**Rationale**:
- Prevents privilege escalation via setuid binaries
- Blocks container breakout techniques requiring privilege changes

### 5. Resource Limits (Template)

**Implementation**: docker-compose.yml lines 72-79 (commented template)
```yaml
deploy:
  resources:
    limits:
      cpus: '2.0'
      memory: 1G
```

**Rationale**:
- Prevents resource exhaustion DoS attacks
- Isolates blast radius from noisy neighbor containers
- Forces predictable performance envelope

**Deployment Guide**: Operators should uncomment and tune based on expected load

### 6. Temporary Filesystem Hardening

**Implementation**: docker-compose.yml lines 60-62
```yaml
tmpfs:
  - /tmp:noexec,nosuid,size=64M
```

**Options**:
- `noexec` - Prevents execution of binaries from /tmp
- `nosuid` - Ignores setuid/setgid bits
- `size=64M` - Caps temporary storage

**Rationale**:
- Mitigates code injection attacks using /tmp as staging
- Prevents privilege escalation via /tmp binaries

### 7. Health Monitoring

**Implementation**: Dockerfile lines 107-109, docker-compose.yml lines 64-70
```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3
```

**Endpoint**: `GET /health` (unauthenticated)

**Rationale**:
- Detects service degradation or crash loops
- Enables automated recovery via orchestration
- Provides operational visibility

**Failure Action**: Docker restarts container after 3 consecutive failures

### 8. Volume Encryption (Recommended)

**Implementation**: docker-compose.yml lines 88-91 (commented guidance)
```yaml
volumes:
  mcpambassador-data:
    driver_opts:
      encrypted: "true"  # Requires encryption plugin
```

**Rationale**:
- Protects data at rest (database, TLS keys, audit logs)
- Compliance requirement for sensitive deployments
- Defense-in-depth against physical disk theft

**Deployment Guide**: Operators should enable for production (requires Docker encryption plugin)

### 9. Process Isolation

**Implementation**: Single-process container (CMD line 113)
```dockerfile
CMD ["node", "packages/server/dist/bin/server.js"]
```

**Rationale**:
- Single process tree - no sidecar daemons
- Clear failure domain
- Simplifies security monitoring and debugging

### 10. Explicit Capability Drop (Future)

**Status**: Not yet implemented (deferred to Phase 2)

**Proposed Implementation**:
```yaml
cap_drop:
  - ALL
cap_add:
  - NET_BIND_SERVICE  # Only if binding to privileged ports
```

**Rationale**:
- Drops all Linux capabilities by default
- Principle of least privilege at kernel level
- Blocks kernel-level exploits

**Deferral Reason**: Current port 8443 doesn't require privileged port binding

## Security Validation Checklist

### Pre-Deployment

- [ ] Review `.env` configuration (no secrets hardcoded)
- [ ] Enable volume encryption for production
- [ ] Tune resource limits based on expected load
- [ ] Verify TLS certificates will be auto-generated
- [ ] Confirm backup strategy for `/data` volume

### Post-Deployment

- [ ] Verify container runs as UID 1000 (non-root)
- [ ] Confirm root filesystem is read-only: `docker exec <container> touch /test` (should fail)
- [ ] Check health endpoint: `curl -k https://localhost:8443/health`
- [ ] Review container logs: `docker-compose logs -f`
- [ ] Verify no processes running as root: `docker exec <container> ps aux`
- [ ] Confirm data persistence: `docker-compose down && docker-compose up` (database should survive)

## Threat Model Coverage

| Threat | Mitigation | Status |
|--------|-----------|--------|
| Privilege escalation | Non-root user + no-new-privileges + read-only FS | ✅ Implemented |
| Code injection | tmpfs noexec + read-only FS | ✅ Implemented |
| Resource exhaustion DoS | Resource limits template | ⚠️ Optional (operator must enable) |
| Data exfiltration | Network isolation + volume encryption | ⚠️ Partial (volume encryption optional) |
| Malware persistence | Read-only FS + minimal attack surface | ✅ Implemented |
| Container breakout | Non-root user + security opts + Alpine base | ✅ Implemented |
| Credential theft | Volume encryption + restrictive file permissions | ⚠️ Partial (volume encryption optional) |

## Compliance Mapping

### CIS Docker Benchmark v1.6

- ✅ 4.1 - Image created with non-root user
- ✅ 4.5 - Content trust enabled (via hash pinning of base image)
- ✅ 5.12 - Root filesystem mounted read-only
- ✅ 5.25 - Container restricted from acquiring additional privileges
- ⚠️ 5.28 - PIDs cgroup limit (deferred to Phase 2)

### OWASP Container Security

- ✅ Minimize attack surface (multi-stage build)
- ✅ Run as non-root user
- ✅ Immutable container (read-only FS)
- ✅ Resource limits template provided
- ⚠️ Secrets management (operators must use environment or volume mounts)

## Operational Security

### Backup Strategy

Backup the named volume `mcpambassador-data`:
```bash
docker run --rm -v mcpambassador-data:/data -v $(pwd)/backups:/backup alpine tar czf /backup/ambassador-data-$(date +%Y%m%d).tar.gz /data
```

### Log Monitoring

Container logs to stdout/stderr (captured by Docker):
```bash
docker-compose logs -f --tail=100
```

Audit logs persisted to `/data/audit.jsonl` (survives container restart).

### Update Procedure

1. Backup data volume
2. `docker-compose pull` (if using registry)
3. `docker-compose up -d` (rolling restart)
4. Verify health: `curl -k https://localhost:8443/health`
5. Review logs for errors

### Incident Response

If container compromised:
1. Immediately stop container: `docker-compose down`
2. Preserve volume for forensics: `docker volume inspect mcpambassador-data`
3. Extract audit logs: `docker run --rm -v mcpambassador-data:/data alpine cat /data/audit.jsonl > audit-forensics.jsonl`
4. Rebuild from clean image
5. Restore data from backup (if data volume compromised)
6. Rotate all API keys via admin endpoints

## Future Hardening (Phase 2+)

1. **Distroless Base Image** - Replace Alpine with Google Distroless for even smaller attack surface
2. **Capability Dropping** - Implement explicit capability whitelist
3. **AppArmor/SELinux Profile** - MAC (Mandatory Access Control) enforcement
4. **Network Policies** - Restrict egress to only downstream MCP servers
5. **Secrets Management** - Integrate HashiCorp Vault or Kubernetes secrets
6. **Image Scanning** - CI/CD integration with Trivy/Grype for CVE detection
7. **Runtime Security** - Falco or Sysdig for anomaly detection

## References

- [CIS Docker Benchmark v1.6](https://www.cisecurity.org/benchmark/docker)
- [OWASP Container Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)
- [Docker Security Best Practices](https://docs.docker.com/develop/security-best-practices/)
- [NIST SP 800-190 - Application Container Security Guide](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-190.pdf)

---

**Review**: DevOps Engineer + Security Engineer  
**Approval**: Lead Developer  
**Next**: M7.4 - E2E Test Suite
