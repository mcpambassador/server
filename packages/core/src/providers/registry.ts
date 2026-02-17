/**
 * Provider Registry
 *
 * Dynamic provider loading with allow-list enforcement and lifecycle management.
 *
 * @see Architecture §5.4 Provider Lifecycle
 * @see ADR-002 Pluggable AAA Module Architecture
 * @see Security Finding F-008 (Supply Chain Security)
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */

import type {
  AuthenticationProvider,
  AuthorizationProvider,
  AuditProvider,
  ProviderLifecycle,
} from '../spi/index.js';
import { logger } from '../utils/logger.js';
import { AmbassadorError } from '../utils/errors.js';

/**
 * Provider type discriminator
 */
export type ProviderType = 'authentication' | 'authorization' | 'audit';

/**
 * Provider registry for managing pluggable AAA modules
 */
export class ProviderRegistry {
  private authnProviders = new Map<string, AuthenticationProvider>();
  private authzProviders = new Map<string, AuthorizationProvider>();
  private auditProviders = new Map<string, AuditProvider>();

  private allowedPackages: string[];

  constructor(allowedPackages: string[]) {
    this.allowedPackages = allowedPackages;
  }

  /**
   * Load and initialize a provider from a package
   *
   * @param type Provider type
   * @param packageName NPM package name (e.g., '@mcpambassador/authn-apikey')
   * @param config Provider-specific configuration
   * @returns Initialized provider instance
   */
  async loadProvider(
    type: ProviderType,
    packageName: string,
    config: Record<string, unknown>
  ): Promise<AuthenticationProvider | AuthorizationProvider | AuditProvider> {
    // Enforce allow-list (F-008)
    if (!this.allowedPackages.includes(packageName)) {
      logger.error(`[registry] Blocked attempt to load non-allowed package: ${packageName}`);
      throw new AmbassadorError(
        `Package ${packageName} is not in the allowed providers list`,
        'provider_not_allowed'
      );
    }

    logger.info(`[registry] Loading ${type} provider from ${packageName}`);

    try {
      // Dynamic import
      const module = await import(packageName);

      // Extract provider class (convention: default export or named export matching type)
      const ProviderClass = module.default || module[this.getExpectedExportName(type)];

      if (!ProviderClass) {
        throw new AmbassadorError(
          `Package ${packageName} does not export a valid provider class`,
          'provider_load_error'
        );
      }

      // Instantiate provider
      const provider = new ProviderClass() as ProviderLifecycle;

      // Validate provider interface (F-SEC-M3-007)
      this.validateProviderInterface(type, provider);

      // Initialize with config
      await provider.initialize(config);

      // Health check
      const health = await provider.healthCheck();
      if (health.status === 'unhealthy') {
        throw new AmbassadorError(
          `Provider ${packageName} failed health check: ${health.message}`,
          'provider_unhealthy'
        );
      }

      // Register in appropriate map
      this.registerProvider(type, provider);

      logger.info(
        `[registry] Provider ${packageName} loaded successfully (status: ${health.status})`
      );
      return provider as AuthenticationProvider | AuthorizationProvider | AuditProvider;
    } catch (error) {
      if (error instanceof AmbassadorError) {
        throw error;
      }
      if (error instanceof Error) {
        throw new AmbassadorError(
          `Failed to load provider ${packageName}: ${error.message}`,
          'provider_load_error'
        );
      }
      throw error;
    }
  }

  /**
   * Validate provider implements required interface (F-SEC-M3-007)
   */
  private validateProviderInterface(type: ProviderType, provider: ProviderLifecycle): void {
    // Check lifecycle methods (required for all providers)
    if (typeof provider.initialize !== 'function') {
      throw new AmbassadorError('Provider missing initialize() method', 'provider_invalid');
    }
    if (typeof provider.healthCheck !== 'function') {
      throw new AmbassadorError('Provider missing healthCheck() method', 'provider_invalid');
    }
    if (!('id' in provider) || typeof (provider as { id: unknown }).id !== 'string') {
      throw new AmbassadorError('Provider missing id property', 'provider_invalid');
    }

    // Check type-specific methods
    switch (type) {
      case 'authentication': {
        const authnProvider = provider as AuthenticationProvider;
        if (typeof authnProvider.authenticate !== 'function') {
          throw new AmbassadorError(
            'AuthenticationProvider missing authenticate() method',
            'provider_invalid'
          );
        }
        break;
      }
      case 'authorization': {
        const authzProvider = provider as AuthorizationProvider;
        if (typeof authzProvider.authorize !== 'function') {
          throw new AmbassadorError(
            'AuthorizationProvider missing authorize() method',
            'provider_invalid'
          );
        }
        if (typeof authzProvider.listAuthorizedTools !== 'function') {
          throw new AmbassadorError(
            'AuthorizationProvider missing listAuthorizedTools() method',
            'provider_invalid'
          );
        }
        break;
      }
      case 'audit': {
        const auditProvider = provider as AuditProvider;
        if (typeof auditProvider.emit !== 'function') {
          throw new AmbassadorError('AuditProvider missing emit() method', 'provider_invalid');
        }
        if (typeof auditProvider.flush !== 'function') {
          throw new AmbassadorError('AuditProvider missing flush() method', 'provider_invalid');
        }
        break;
      }
    }
  }

  /**
   * Register provider instance in registry
   */
  private registerProvider(type: ProviderType, provider: ProviderLifecycle): void {
    switch (type) {
      case 'authentication':
        this.authnProviders.set(
          (provider as AuthenticationProvider).id,
          provider as AuthenticationProvider
        );
        break;
      case 'authorization':
        this.authzProviders.set(
          (provider as AuthorizationProvider).id,
          provider as AuthorizationProvider
        );
        break;
      case 'audit':
        this.auditProviders.set((provider as AuditProvider).id, provider as AuditProvider);
        break;
    }
  }

  /**
   * Get expected export name for provider type
   */
  private getExpectedExportName(type: ProviderType): string {
    switch (type) {
      case 'authentication':
        return 'AuthenticationProvider';
      case 'authorization':
        return 'AuthorizationProvider';
      case 'audit':
        return 'AuditProvider';
    }
  }

  /**
   * Get authentication provider by ID
   */
  getAuthenticationProvider(id: string): AuthenticationProvider {
    const provider = this.authnProviders.get(id);
    if (!provider) {
      throw new AmbassadorError(`Authentication provider '${id}' not found`, 'provider_not_found');
    }
    return provider;
  }

  /**
   * Get authorization provider by ID
   */
  getAuthorizationProvider(id: string): AuthorizationProvider {
    const provider = this.authzProviders.get(id);
    if (!provider) {
      throw new AmbassadorError(`Authorization provider '${id}' not found`, 'provider_not_found');
    }
    return provider;
  }

  /**
   * Get audit provider by ID
   */
  getAuditProvider(id: string): AuditProvider {
    const provider = this.auditProviders.get(id);
    if (!provider) {
      throw new AmbassadorError(`Audit provider '${id}' not found`, 'provider_not_found');
    }
    return provider;
  }

  /**
   * Shutdown all providers gracefully
   */
  async shutdown(): Promise<void> {
    logger.info('[registry] Shutting down all providers');

    const shutdownPromises: Promise<void>[] = [];

    for (const provider of this.authnProviders.values()) {
      if (provider.shutdown) {
        shutdownPromises.push(provider.shutdown());
      }
    }

    for (const provider of this.authzProviders.values()) {
      if (provider.shutdown) {
        shutdownPromises.push(provider.shutdown());
      }
    }

    for (const provider of this.auditProviders.values()) {
      if (provider.shutdown) {
        shutdownPromises.push(provider.shutdown());
      }
    }

    await Promise.all(shutdownPromises);
    logger.info('[registry] All providers shut down');
  }
}
