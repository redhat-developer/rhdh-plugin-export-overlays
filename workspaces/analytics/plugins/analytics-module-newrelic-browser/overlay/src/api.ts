import {
  analyticsApiRef,
  configApiRef,
  identityApiRef,
} from '@backstage/core-plugin-api';
import { NewRelicBrowser } from '@backstage-community/plugin-analytics-module-newrelic-browser';
  
export const newRelicAnalyticsApi: AnyApiFactory = ({
  api: analyticsApiRef,
  deps: { configApi: configApiRef, identityApi: identityApiRef },
  factory: ({ configApi, identityApi }) =>
    NewRelicBrowser.fromConfig(configApi, {
      identityApi,
  }),
});
