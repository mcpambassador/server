import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MagnifyingGlassIcon, CubeIcon, KeyIcon, ChevronDownIcon, WrenchScrewdriverIcon } from '@heroicons/react/20/solid';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { EmptyState } from '@/components/shared/EmptyState';
import { Input } from '@/components/catalyst/input';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Tabs, TabsList, TabsTrigger, TabsContent, TabsPanels } from '@/components/catalyst/tabs';
import { useMarketplace } from '@/api/hooks/use-marketplace';
import { usePageTitle } from '@/hooks/usePageTitle';
import type { McpTool } from '@/api/types';

const ALL_CATEGORY = 'all';
const TOOL_PREVIEW_LIMIT = 5;

function McpIcon({ iconUrl, name }: { iconUrl?: string; name: string }) {
  const [errored, setErrored] = useState(false);

  if (iconUrl && !errored) {
    return (
      <img
        src={iconUrl}
        alt={`${name} icon`}
        className="size-5 shrink-0 rounded object-contain"
        onError={() => setErrored(true)}
      />
    );
  }

  return <CubeIcon className="size-5 text-zinc-400 dark:text-zinc-500 shrink-0" />;
}

function ToolPreview({ tools }: { tools: McpTool[] }) {
  const [open, setOpen] = useState(false);

  if (tools.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <CubeIcon className="size-3.5 shrink-0" />
        <span>0 tools</span>
      </div>
    );
  }

  const preview = tools.slice(0, TOOL_PREVIEW_LIMIT);
  const overflow = tools.length - TOOL_PREVIEW_LIMIT;

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors group"
        aria-expanded={open}
      >
        <CubeIcon className="size-3.5 shrink-0" />
        <span>
          {tools.length} {tools.length === 1 ? 'tool' : 'tools'}
        </span>
        <ChevronDownIcon
          className={`size-3.5 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <ul
          className="mt-2 space-y-1 rounded-md border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-zinc-900/50 px-3 py-2"
          role="list"
        >
          {preview.map((tool) => (
            <li
              key={tool.name}
              className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300"
            >
              <WrenchScrewdriverIcon className="size-3 shrink-0 text-zinc-400 dark:text-zinc-500" />
              <span className="font-mono truncate">{tool.name}</span>
            </li>
          ))}
          {overflow > 0 && (
            <li className="text-xs text-zinc-400 dark:text-zinc-500 pt-0.5 pl-5">
              +{overflow} more — view details for full list
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export function Marketplace() {
  usePageTitle('Marketplace');
  const { data: marketplace, isLoading } = useMarketplace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState('');

  const activeCategory = searchParams.get('category') ?? ALL_CATEGORY;

  const categories = useMemo(() => {
    if (!marketplace?.data) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const mcp of marketplace.data) {
      if (mcp.category && !seen.has(mcp.category)) {
        seen.add(mcp.category);
        result.push(mcp.category);
      }
    }
    return result.sort((a, b) => a.localeCompare(b));
  }, [marketplace?.data]);

  const filteredMcps = useMemo(() => {
    const entries = marketplace?.data ?? [];
    return entries.filter((mcp) => {
      const lowerQuery = searchQuery.toLowerCase();
      const matchesSearch =
        !searchQuery ||
        mcp.name.toLowerCase().includes(lowerQuery) ||
        mcp.description?.toLowerCase().includes(lowerQuery);

      const matchesCategory =
        activeCategory === ALL_CATEGORY || mcp.category === activeCategory;

      return matchesSearch && matchesCategory;
    });
  }, [marketplace?.data, searchQuery, activeCategory]);

  function handleCategoryChange(category: string) {
    if (category === ALL_CATEGORY) {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ category }, { replace: true });
    }
  }

  // Derive the index of the selected tab so Catalyst Tabs stays in sync with URL params
  const allTabKeys = [ALL_CATEGORY, ...categories];
  const selectedTabIndex = Math.max(allTabKeys.indexOf(activeCategory), 0);

  const McpGrid = ({ mcps }: { mcps: typeof filteredMcps }) => {
    if (isLoading) {
      return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
              <div className="animate-pulse space-y-3">
                <div className="h-6 w-3/4 rounded bg-zinc-200 dark:bg-zinc-700" />
                <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
                <div className="h-20 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (mcps.length === 0) {
      return (
        <EmptyState
          icon={<CubeIcon className="size-6 text-zinc-400" />}
          title="No MCPs Found"
          description={
            searchQuery || activeCategory !== ALL_CATEGORY
              ? 'No MCPs match your current filters. Try adjusting your search or category selection.'
              : 'No MCPs are currently available in the marketplace.'
          }
        />
      );
    }

    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {mcps.map((mcp) => (
          <div
            key={mcp.id}
            className="flex flex-col rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10 hover:ring-zinc-950/20 dark:hover:ring-white/20 transition-shadow"
          >
            <div className="flex flex-col flex-1 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">{mcp.name}</h3>
                <McpIcon iconUrl={mcp.icon_url} name={mcp.name} />
              </div>
              <p className="text-sm/6 text-zinc-500 dark:text-zinc-400 line-clamp-2">
                {mcp.description || 'No description available'}
              </p>
              <div className="space-y-2">
                <ToolPreview tools={mcp.tools} />
                <div className="flex flex-wrap gap-1.5">
                  <Badge color="zinc" className="text-xs">
                    {mcp.isolationMode === 'per-user' ? 'Per-User' : 'Shared'}
                  </Badge>
                  {mcp.category && (
                    <Badge color="blue" className="text-xs">
                      {mcp.category}
                    </Badge>
                  )}
                  {mcp.requiresUserCredentials && (
                    <Badge color="zinc" className="text-xs">
                      <KeyIcon className="size-3 mr-1" />
                      Credentials
                    </Badge>
                  )}
                </div>
              </div>
              <div className="mt-auto pt-1">
                <Button href={`/app/marketplace/${mcp.id}`} color="zinc" className="w-full">
                  View Details
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Heading>Marketplace</Heading>
        <Text>Discover and subscribe to MCP servers</Text>
      </div>

      {/* Search */}
      <div className="relative">
        <MagnifyingGlassIcon className="absolute left-3 top-1/2 size-5 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" />
        <Input
          placeholder="Search MCPs..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Category filter — Catalyst Tabs for keyboard navigation + aria handling */}
      {!isLoading && categories.length > 0 ? (
        <Tabs
          selectedIndex={selectedTabIndex}
          onChange={(index) => handleCategoryChange(allTabKeys[index] ?? ALL_CATEGORY)}
        >
          <TabsList>
            <TabsTrigger>All</TabsTrigger>
            {categories.map((category) => (
              <TabsTrigger key={category}>{category}</TabsTrigger>
            ))}
          </TabsList>
          <TabsPanels>
            {/* One panel per tab; all panels show the same filtered grid driven by URL state */}
            {allTabKeys.map((key) => (
              <TabsContent key={key}>
                <McpGrid mcps={filteredMcps} />
              </TabsContent>
            ))}
          </TabsPanels>
        </Tabs>
      ) : (
        <McpGrid mcps={filteredMcps} />
      )}
    </div>
  );
}
