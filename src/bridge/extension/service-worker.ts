import { installBrowserPilotBridgeRouter } from "./service_worker/router";
import { installBrowserPilotTransport } from "./service_worker/transport";

installBrowserPilotBridgeRouter();
installBrowserPilotTransport();
