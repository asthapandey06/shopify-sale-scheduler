import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext, type HandleDataRequestFunction } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { config } from "./config.server";
import { applySecurityHeaders } from "./lib/security-headers";
import { logger } from "./lib/logger";
import { startScheduler } from "./services/scheduler.server";

export const streamTimeout = 5000;

if (config.schedulerEnabled && process.env.NODE_ENV !== "test") {
  startScheduler();
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
) {
  // Sets the Content-Security-Policy frame-ancestors for the shop's admin.
  addDocumentResponseHeaders(request, responseHeaders);
  applySecurityHeaders(responseHeaders, config.isProduction);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          logger.error("Render error", { error: error as Error });
        },
      },
    );

    setTimeout(abort, streamTimeout + 1000);
  });
}

export const handleDataRequest: HandleDataRequestFunction = (response) => {
  applySecurityHeaders(response.headers, config.isProduction);
  return response;
};
