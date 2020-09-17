import type { Location } from "history";
import { parsePath } from "history";

import type { BuildManifest, ServerEntryModule, RouteModules } from "./build";
import {
  getBrowserManifest,
  getRouteModules,
  getServerEntryModule,
  getServerManifest
} from "./build";
import type { RemixConfig } from "./config";
import { readConfig } from "./config";
import type { EntryContext } from "./entry";
import {
  createRouteData,
  createRouteManifest,
  createRouteParams
} from "./entry";
import type { AppLoadContext } from "./loader";
import {
  LoaderResult,
  LoaderResultChangeStatusCode,
  LoaderResultRedirect,
  LoaderResultError,
  loadData,
  loadDataDiff
} from "./loader";
import { matchRoutes } from "./match";
import type { Request } from "./platform";
import { Response } from "./platform";
import { purgeRequireCache } from "./requireCache";

export interface RequestHandler {
  (request: Request, loadContext: AppLoadContext): Promise<Response>;
}

function createLocation(
  url: string,
  state: Location["state"] = null,
  key: Location["key"] = "default"
): Location {
  let { pathname = "/", search = "", hash = "" } = parsePath(url);
  return { pathname, search, hash, state, key };
}

/**
 * Creates a HTTP request handler.
 */
export function createRequestHandler(remixRoot?: string): RequestHandler {
  let initPromise = initializeServer(remixRoot);

  return async (req, loadContext) => {
    if (process.env.NODE_ENV === "development") {
      let { config } = await initPromise;
      purgeRequireCache(config.rootDirectory);
      initPromise = initializeServer(remixRoot);
    }

    let init = await initPromise;

    // /__remix_data?path=/gists
    // /__remix_data?from=/gists&path=/gists/123
    if (req.url.startsWith("/__remix_data")) {
      return handleDataRequest(init, req, loadContext);
    }

    // /gists
    // /gists/123
    return handleHtmlRequest(init, req, loadContext);
  };
}

interface RemixServerInit {
  config: RemixConfig;
  browserManifest: BuildManifest;
  routeModules: RouteModules;
  serverEntryModule: ServerEntryModule;
}

async function initializeServer(remixRoot?: string): Promise<RemixServerInit> {
  let config = await readConfig(remixRoot);

  let browserManifest = getBrowserManifest(config.serverBuildDirectory);
  let serverManifest = getServerManifest(config.serverBuildDirectory);
  let serverEntryModule = getServerEntryModule(
    config.serverBuildDirectory,
    serverManifest
  );
  let routeModules = getRouteModules(
    config.serverBuildDirectory,
    config.routes,
    serverManifest
  );

  return { config, browserManifest, serverEntryModule, routeModules };
}

async function handleDataRequest(
  init: RemixServerInit,
  req: Request,
  context: AppLoadContext
): Promise<Response> {
  let { config } = init;

  let location = createLocation(req.url);
  let params = new URLSearchParams(location.search);
  let path = params.get("path");
  let from = params.get("from");

  if (!path) {
    return new Response(JSON.stringify({ error: "Missing ?path" }), {
      status: 403,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }

  let matches = matchRoutes(config.routes, path);

  if (!matches) {
    return new Response(JSON.stringify({ error: "No routes matched" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }

  let loaderResults;
  if (from) {
    let fromMatches = matchRoutes(config.routes, from) || [];
    loaderResults = await loadDataDiff(
      config,
      matches,
      fromMatches,
      location,
      context
    );
  } else {
    loaderResults = await loadData(config, matches, location, context);
  }

  // TODO: How to handle redirects/status code changes?

  let data = createRouteData(loaderResults);

  // TODO: How do we cache this?
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json"
    }
  });
}

async function handleHtmlRequest(
  init: RemixServerInit,
  req: Request,
  context: AppLoadContext
): Promise<Response> {
  let { config, browserManifest, routeModules, serverEntryModule } = init;

  let location = createLocation(req.url);
  let statusCode = 200;
  let matches = matchRoutes(config.routes, req.url);
  let loaderResults: LoaderResult[] = [];

  if (!matches) {
    statusCode = 404;
    matches = [
      {
        pathname: location.pathname,
        params: {},
        route: {
          path: "*",
          id: "routes/404",
          component: "routes/404.js",
          loader: null
        }
      }
    ];
  } else {
    loaderResults = await loadData(config, matches, location, context);

    let redirectResult = loaderResults.find(
      (result): result is LoaderResultRedirect =>
        result instanceof LoaderResultRedirect
    );

    if (redirectResult) {
      return new Response(`Redirecting to ${redirectResult.location}`, {
        status: redirectResult.httpStatus,
        headers: {
          Location: redirectResult.location
        }
      });
    }

    let errorResult = loaderResults.find(
      (result: LoaderResult): result is LoaderResultError =>
        result instanceof LoaderResultError
    );

    if (errorResult) {
      statusCode = errorResult.httpStatus;
      matches = [
        {
          pathname: location.pathname,
          params: {},
          route: {
            path: "*",
            id: "routes/500",
            component: "routes/500.js",
            loader: null
          }
        }
      ];
    } else {
      let changeStatusCodeResult = loaderResults.find(
        (result): result is LoaderResultChangeStatusCode =>
          result instanceof LoaderResultChangeStatusCode
      );

      if (changeStatusCodeResult) {
        statusCode = changeStatusCodeResult.httpStatus;
        matches = [
          {
            pathname: location.pathname,
            params: {},
            route: {
              path: "*",
              id: `routes/${changeStatusCodeResult.httpStatus}`,
              component: `routes/${changeStatusCodeResult.httpStatus}.js`,
              loader: null
            }
          }
        ];
      }
    }
  }

  let matchedRouteIds = matches.map(match => match.route.id);
  let routeData = createRouteData(loaderResults);
  let routeManifest = createRouteManifest(matches);
  let routeParams = createRouteParams(matches);

  // Get the browser manifest for only the browser entry point + the matched routes.
  let partialBrowserManifest = getPartialManifest(
    browserManifest,
    ["__entry_browser__"].concat(matchedRouteIds)
  );

  let entryContext: EntryContext = {
    browserManifest: partialBrowserManifest,
    matchedRouteIds,
    publicPath: config.publicPath,
    routeManifest,
    routeData,
    routeParams,
    requireRoute(routeId: string) {
      return routeModules[routeId];
    }
  };

  return serverEntryModule.default(req, statusCode, entryContext);
}

function getPartialManifest(
  manifest: BuildManifest,
  entryNames: string[]
): BuildManifest {
  return entryNames.reduce((memo, entryName) => {
    memo[entryName] = manifest[entryName];
    return memo;
  }, {} as BuildManifest);
}