import {
    analyticsApiRef,
    configApiRef,
    identityApiRef,
  } from '@backstage/core-plugin-api';
  import { GoogleAnalytics4 } from '@backstage-community/plugin-analytics-module-ga4';
  
export const googleAnalytics4Api: AnyApiFactory = createApiFactory({
  api: analyticsApiRef,
  deps: { configApi: configApiRef, identityApi: identityApiRef },
  factory: ({ configApi, identityApi }) =>
    GoogleAnalytics4.fromConfig(configApi, {
      identityApi,
  }),
});
