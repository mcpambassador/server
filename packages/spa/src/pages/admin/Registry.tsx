import { useState } from 'react';
import {
  MagnifyingGlassIcon,
  CubeIcon,
  CheckBadgeIcon,
  ArrowPathIcon,
  GlobeAltIcon,
} from '@heroicons/react/20/solid';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Input } from '@/components/catalyst/input';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { InlineAlert } from '@/components/catalyst/inline-alert';
import { useRegistry, useInstallRegistryMcp, useRefreshRegistry } from '@/api/hooks/use-registry';
import { usePageTitle } from '@/hooks/usePageTitle';
import type { RegistryMcp } from '@/api/types';

export function Registry() {
  usePageTitle('Community Registry');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const { data: registryData, isLoading } = useRegistry();
  const installMutation = useInstallRegistryMcp();
  const refreshMutation = useRefreshRegistry();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const categories = [
    'all',
    'Developer Tools',
    'Finance & Data',
    'Search & Web',
    'Productivity',
    'Utilities',
  ];

  const handleInstall = async (mcp: RegistryMcp) => {
    setSuccessMessage(null);
    setErrorMessage(null);

    try {
      const result = await installMutation.mutateAsync(mcp.name);
      setSuccessMessage(
        `Successfully installed ${mcp.display_name}. MCP ID: ${result.mcp_id}`
      );
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
        setErrorMessage(`${mcp.display_name} is already installed`);
      } else {
        setErrorMessage(`Failed to install ${mcp.display_name}`);
      }
    }
  };

  const handleRefresh = async () => {
    setSuccessMessage(null);
    setErrorMessage(null);

    try {
      const result = await refreshMutation.mutateAsync();
      setSuccessMessage(`Registry refreshed: ${result.mcp_count} MCPs loaded`);
    } catch (error) {
      setErrorMessage('Failed to refresh registry');
    }
  };

  const filteredMcps =
    registryData?.mcps?.filter((mcp) => {
      const matchesSearch =
        mcp.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        mcp.display_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        mcp.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        mcp.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesCategory =
        selectedCategory === 'all' || mcp.category === selectedCategory;

      return matchesSearch && matchesCategory;
    }) ?? [];

  const formatLastUpdate = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const getTransportColor = (transport: string) =>
    transport === 'http' ? 'blue' : 'zinc';

  const getAuthColor = (authType: string) => {
    switch (authType) {
      case 'none':
        return 'green';
      case 'static':
        return 'amber';
      case 'oauth2':
        return 'purple';
      default:
        return 'zinc';
    }
  };

  const getAuthLabel = (authType: string) => {
    switch (authType) {
      case 'none':
        return 'No Auth';
      case 'static':
        return 'API Key';
      case 'oauth2':
        return 'OAuth2';
      default:
        return authType;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <Heading>Community Registry</Heading>
          {registryData?.registry && (
            <Text>
              {registryData.registry.name} • {registryData.registry.mcp_count} MCPs • Last
              updated: {formatLastUpdate(registryData.registry.last_fetched_at)}
            </Text>
          )}
        </div>
        <Button
          color="zinc"
          onClick={handleRefresh}
          disabled={refreshMutation.isPending}
        >
          {refreshMutation.isPending ? (
            <>
              <ArrowPathIcon className="animate-spin" />
              Refreshing...
            </>
          ) : (
            <>
              <ArrowPathIcon />
              Refresh
            </>
          )}
        </Button>
      </div>

      {/* Success/Error Messages */}
      {successMessage && (
        <InlineAlert color="green" onClose={() => setSuccessMessage(null)}>
          {successMessage}
        </InlineAlert>
      )}
      {errorMessage && (
        <InlineAlert color="red" onClose={() => setErrorMessage(null)}>
          {errorMessage}
        </InlineAlert>
      )}

      {/* Search Bar */}
      <div className="relative">
        <MagnifyingGlassIcon className="absolute left-3 top-1/2 size-5 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" />
        <Input
          placeholder="Search MCPs by name, description, or tags..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Category Filter */}
      <div className="flex flex-wrap gap-2">
        {categories.map((category) => (
          <Badge
            key={category}
            color={selectedCategory === category ? 'blue' : 'zinc'}
            className="cursor-pointer"
            onClick={() => setSelectedCategory(category)}
          >
            {category === 'all' ? 'All Categories' : category}
          </Badge>
        ))}
      </div>

      {/* MCP Grid */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10"
            >
              <div className="animate-pulse space-y-3">
                <div className="h-6 w-3/4 rounded bg-zinc-200 dark:bg-zinc-700" />
                <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
                <div className="h-20 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredMcps.length === 0 ? (
        <div className="rounded-lg bg-white dark:bg-white/5 p-12 ring-1 ring-zinc-950/10 dark:ring-white/10 text-center">
          <GlobeAltIcon className="mx-auto size-12 text-zinc-400 dark:text-zinc-500" />
          <h3 className="mt-4 text-base/7 font-semibold text-zinc-900 dark:text-white">
            No MCPs Found
          </h3>
          <p className="mt-2 text-sm/6 text-zinc-500 dark:text-zinc-400">
            {searchQuery || selectedCategory !== 'all'
              ? 'No MCPs match your search criteria. Try a different search term or category.'
              : 'No MCPs are currently available in the community registry.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredMcps.map((mcp) => (
            <div
              key={mcp.name}
              className="flex flex-col rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10 hover:ring-zinc-950/20 dark:hover:ring-white/20 transition-shadow"
            >
              <div className="flex-1 space-y-3">
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-3">
                    {mcp.icon_url ? (
                      <img
                        src={mcp.icon_url}
                        alt={mcp.display_name}
                        className="size-8 rounded shrink-0"
                      />
                    ) : (
                      <CubeIcon className="size-8 text-zinc-400 dark:text-zinc-500 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white truncate">
                          {mcp.display_name}
                        </h3>
                        {mcp.verified && (
                          <CheckBadgeIcon className="size-5 text-green-600 dark:text-green-500 shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">{mcp.name}</p>
                    </div>
                  </div>
                </div>

                {/* Description */}
                <p className="text-sm/6 text-zinc-500 dark:text-zinc-400 line-clamp-2">
                  {mcp.description}
                </p>

                {/* Badges */}
                <div className="flex flex-wrap gap-1.5">
                  <Badge color={getTransportColor(mcp.transport_type)} className="text-xs">
                    {mcp.transport_type.toUpperCase()}
                  </Badge>
                  <Badge color={getAuthColor(mcp.auth_type)} className="text-xs">
                    {getAuthLabel(mcp.auth_type)}
                  </Badge>
                  <Badge color="zinc" className="text-xs">
                    {mcp.category}
                  </Badge>
                  <Badge color="zinc" className="text-xs">
                    {mcp.isolation_mode === 'per_user' ? 'Per-User' : 'Shared'}
                  </Badge>
                </div>

                {/* Tags */}
                {mcp.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {mcp.tags.slice(0, 3).map((tag, idx) => (
                      <span
                        key={idx}
                        className="text-xs text-zinc-500 dark:text-zinc-400"
                      >
                        #{tag}
                      </span>
                    ))}
                    {mcp.tags.length > 3 && (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        +{mcp.tags.length - 3} more
                      </span>
                    )}
                  </div>
                )}

                {/* Version & Maintainer */}
                <div className="text-xs text-zinc-500 dark:text-zinc-400 space-y-0.5">
                  <div>Version: {mcp.version}</div>
                  <div>Maintainer: {mcp.maintainer}</div>
                </div>

                {/* Links */}
                {(mcp.repository_url || mcp.documentation_url) && (
                  <div className="flex gap-3 text-xs">
                    {mcp.repository_url && (
                      <a
                        href={mcp.repository_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        Repository
                      </a>
                    )}
                    {mcp.documentation_url && (
                      <a
                        href={mcp.documentation_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        Docs
                      </a>
                    )}
                  </div>
                )}
              </div>

              {/* Install Button */}
              <div className="mt-4 pt-4 border-t border-zinc-950/10 dark:border-white/10">
                {mcp.installed ? (
                  <div className="space-y-2">
                    <Badge color="green" className="w-full justify-center">
                      ✓ Installed
                    </Badge>
                    {mcp.installed_mcp_id && (
                      <Button
                        href={`/app/admin/mcps/${mcp.installed_mcp_id}`}
                        color="zinc"
                        className="w-full"
                      >
                        View Details
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    color="blue"
                    className="w-full"
                    onClick={() => handleInstall(mcp)}
                    disabled={installMutation.isPending}
                  >
                    {installMutation.isPending ? 'Installing...' : 'Install'}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
