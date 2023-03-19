const debug = require("debug")("engine:playwright");
const { chromium } = require("playwright");
const {
  browserTiming,
  WEB_VITALS_SCRIPT,
  statsToConsole,
  getHeapSize,
} = require("./browser-eval");

const pageHandlerControlVariables = {
  aggregateByName: false,
  extendedMetrics: undefined,
  showAllPageMetrics: undefined,
};

class PlaywrightEngine {
  constructor(script) {
    debug("constructor");
    this.target = script.config.target;

    this.config = script.config?.engines?.playwright || {};
    this.processor = script.config.processor || {};
    this.launchOptions = this.config.launchOptions || {};
    this.contextOptions = this.config.contextOptions || {};

    this.defaultNavigationTimeout =
      (Number.parseInt(this.config.defaultNavigationTimeout, 10) || 30) * 1000;
    this.defaultTimeout =
      (Number.parseInt(this.config.defaultPageTimeout, 10) || 30) * 1000;

    this.aggregateByName =
      script.config.engines.playwright.aggregateByName || false;
    this.extendedMetrics =
      script.config.engines.playwright.extendedMetrics !== undefined;
    this.showAllPageMetrics =
      script.config.engines.playwright.showAllPageMetrics !== undefined;

    pageHandlerControlVariables.aggregateByName = this.aggregateByName;
    pageHandlerControlVariables.extendedMetrics = this.extendedMetrics;
    pageHandlerControlVariables.showAllPageMetrics = this.showAllPageMetrics;
    return this;
  }

  createScenario(spec, events) {
    debug("createScenario");
    debug(spec);

    //const self = this;
    const aggregateByNameInScenario = this.aggregateByName;
    const launchOptionsInScenario = this.launchOptions;
    const extendedMetricsInScenario = this.extendedMetrics;
    const contextOptionsInScenario = this.contextOptions;
    const defaultNavigationTimeoutInScenario = this.defaultNavigationTimeout;
    const defaultTimeoutInScenario = this.defaultTimeout;
    const targetInScenario = this.target;
    const showAllPageMetricsInScenario = this.showAllPageMetrics;
    const flowFunction = this.processor[spec.flowFunction];
    function getName(url) {
      return aggregateByNameInScenario && spec.name ? spec.name : url;
    }

    return async function scenario(initialContext, callback) {
      events.emit("started");
      const launchOptions = Object.assign(
        {},
        {
          headless: true,
          args: ["--enable-precise-memory-info", "--disable-dev-shm-usage"],
        },
        launchOptionsInScenario
      );

      const contextOptions = contextOptionsInScenario || {};

      const browser = await chromium.launch(launchOptions);
      debug("browser created");
      const context = await browser.newContext(contextOptions);

      context.setDefaultNavigationTimeout(defaultNavigationTimeoutInScenario);
      context.setDefaultTimeout(defaultTimeoutInScenario);
      debug("context created");

      const uniquePageLoadToTiming = {};
      try {
        await context.addInitScript(WEB_VITALS_SCRIPT);
        await context.addInitScript(statsToConsole);

        const page = await context.newPage();

        debug("page created");

        page.on("domcontentloaded", async (pageParameter) => {
          if (!extendedMetricsInScenario) {
            return;
          }

          try {
            const performanceTimingJson = await pageParameter.evaluate(
              browserTiming
            );
            const performanceTiming = JSON.parse(performanceTimingJson);
            const timingName =
              getName(pageParameter.url()) + performanceTiming.connectStart;
            if (uniquePageLoadToTiming[timingName]) {
              return;
            } else {
              uniquePageLoadToTiming[timingName] = performanceTiming;
            }

            debug("domcontentloaded:", getName(pageParameter.url()));
            const startToInteractive =
              performanceTiming.domInteractive -
              performanceTiming.navigationStart;

            events.emit("counter", "browser.page.domcontentloaded", 1);
            events.emit(
              "counter",
              `browser.page.domcontentloaded.${getName(pageParameter.url())}`,
              1
            );
            events.emit(
              "histogram",
              "browser.page.dominteractive",
              startToInteractive
            );
            events.emit(
              "histogram",
              `browser.page.dominteractive.${getName(pageParameter.url())}`,
              startToInteractive
            );
          } catch (error) {
            console.error("domcontentloaded event handler code: %s", error);
          }
        });

        page.on("console", async (message) => {
          if (message.type() === "trace") {
            debug(message);
            try {
              const metric = JSON.parse(message.text());
              const { name, value, url } = metric;

              // We only want metrics for pages on our website, not iframes
              if (
                url.startsWith(targetInScenario) ||
                showAllPageMetricsInScenario
              ) {
                events.emit(
                  "histogram",
                  `browser.page.${name}.${getName(url)}`,
                  value
                );
              }
            } catch (error) {
              console.error("Console event handler code: %s", error);
            }
          }
        });

        page.on("load", async (pageParameter) => {
          if (!extendedMetricsInScenario) {
            return;
          }

          try {
            debug("load:", getName(pageParameter.url()));

            const { usedJSHeapSize } = JSON.parse(
              await pageParameter.evaluate(getHeapSize)
            );
            events.emit(
              "histogram",
              "browser.memory_used_mb",
              usedJSHeapSize / 1000 / 1000
            );
          } catch (error) {
            console.error("Load event handler code: %s", error);
          }
        });

        page.on("pageerror", (error) => {
          debug("pageerror:", getName(page.url()));
          debug("pageerror:", error.message);
        });
        page.on("requestfinished", (_request) => {
          // const timing = _request.timing();
          events.emit("counter", "browser.http_requests", 1);
        });
        //page.on("response", (response) => {});

        await flowFunction(page, initialContext, events);

        await page.close();

        if (callback) {
          callback(undefined, initialContext);
        }
        return initialContext;
      } catch (error) {
        console.error(error);
        if (callback) {
          callback(error, initialContext);
        } else {
          throw error;
        }
      } finally {
        await context.close();
        await browser.close();
      }
    };
  }
}

module.exports = PlaywrightEngine;
