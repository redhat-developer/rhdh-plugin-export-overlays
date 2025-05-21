import {
    AnyApiFactory,
    analyticsApiRef,
    configApiRef,
    createApiFactory,
    identityApiRef,
  } from '@backstage/core-plugin-api';
import { NewRelicBrowser } from './apis/implementations/AnalyticsApi';
  
export const newRelicAnalyticsApi: AnyApiFactory = createApiFactory({
  api: analyticsApiRef,
  deps: { configApi: configApiRef, identityApi: identityApiRef },
  factory: ({ configApi, identityApi }) =>
    NewRelicBrowser.fromConfig(configApi, {
      identityApi,
  }),
});
