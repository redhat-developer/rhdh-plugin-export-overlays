import {
  AnyApiFactory,
  analyticsApiRef,
  configApiRef,
  createApiFactory,
  identityApiRef,
} from '@backstage/core-plugin-api';
import { MatomoAnalytics } from './api/Matomo';

export const MatomoAnalyticsApi: AnyApiFactory = createApiFactory({
  api: analyticsApiRef,
  deps: { configApi: configApiRef, identityApi: identityApiRef },
  factory: ({ configApi, identityApi }) =>
    MatomoAnalytics.fromConfig(configApi, {
      identityApi,
    }),
});
