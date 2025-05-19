export {
  lighthousePlugin,
  lighthousePlugin as plugin,
  LighthousePage,
  EntityLighthouseContent,
  EntityLastLighthouseAuditCard,
} from "./plugin";
export {
  Router,
  isLighthouseAvailable as isPluginApplicableToEntity,
  isLighthouseAvailable,
  EmbeddedRouter,
} from "./Router";
export * from "./api";
export * from "./components/Cards";

export { default as LighthouseIcon } from "@material-ui/icons/Assessment";
