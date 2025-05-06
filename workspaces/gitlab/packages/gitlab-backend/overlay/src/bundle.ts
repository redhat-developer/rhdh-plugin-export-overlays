import { createBackendFeatureLoader } from "@backstage/backend-plugin-api";
import {
  catalogPluginGitlabFillerProcessorModule,
  gitlabPlugin,
} from "./plugin";

export const bundle = createBackendFeatureLoader({
  async loader() {
    return [gitlabPlugin, catalogPluginGitlabFillerProcessorModule];
  },
});