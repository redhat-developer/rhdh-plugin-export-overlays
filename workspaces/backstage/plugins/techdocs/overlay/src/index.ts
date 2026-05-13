import {
  TechDocsEntityMetadata,
  TechDocsMetadata,
} from '@backstage/plugin-techdocs-react';

export * from './types';
export * from './api';
export * from './client';
export * from './reader';
export * from './search';
export * from './home';
export {
  TechDocsCustomHome,
  TechDocsIndexPage,
  TechdocsPage,
  TechDocsSearchResultListItem,
  techdocsPlugin as plugin,
  techdocsPlugin,
} from './plugin';
export {
  isTechDocsAvailable,
  LegacyEmbeddedDocsRouter as EmbeddedDocsRouter,
  Router,
} from './Router';

export type { TechDocsSearchResultListItemProps } from './search/components/TechDocsSearchResultListItem';

/**
 * @deprecated Import from `@backstage/plugin-techdocs-react` instead
 *
 * @public
 */
type DeprecatedTechDocsMetadata = TechDocsMetadata;

/**
 * @deprecated Import from `@backstage/plugin-techdocs-react` instead
 *
 * @public
 */
type DeprecatedTechDocsEntityMetadata = TechDocsEntityMetadata;

export type {
  DeprecatedTechDocsEntityMetadata as TechDocsEntityMetadata,
  DeprecatedTechDocsMetadata as TechDocsMetadata,
};

export * from './overridableComponents';

export {
  EntityTechdocsContent,
  TechDocsReaderPage,
  TechdocsSearchFilter,
  techdocsSearchType,
} from './wrapped';
