import {
  AnyApiFactory,
  analyticsApiRef,
  configApiRef,
  createApiFactory,
  identityApiRef,
} from '@backstage/core-plugin-api';
import { GoogleAnalytics4 } from './apis/implementations/AnalyticsApi';
  
export const googleAnalytics4Api: AnyApiFactory = createApiFactory({
  api: analyticsApiRef,
  deps: { configApi: configApiRef, identityApi: identityApiRef },
  factory: ({ configApi, identityApi }) =>
    GoogleAnalytics4.fromConfig(configApi, {
      identityApi,
  }),
});
