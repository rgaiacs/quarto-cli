/*
* format-reveal.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/
import { join } from "path/mod.ts";

import { Document, Element, NodeType } from "../../core/deno-dom.ts";
import {
  kCodeLineNumbers,
  kFrom,
  kHtmlMathMethod,
  kIncludeInHeader,
  kLinkCitations,
  kReferenceLocation,
  kSlideLevel,
} from "../../config/constants.ts";

import {
  Format,
  kHtmlPostprocessors,
  kMarkdownAfterBody,
  kTextHighlightingMode,
  Metadata,
  PandocFlags,
} from "../../config/types.ts";
import { camelToKebab, kebabToCamel, mergeConfigs } from "../../core/config.ts";
import { formatResourcePath } from "../../core/resources.ts";
import { renderEjs } from "../../core/ejs.ts";
import { TempContext } from "../../core/temp.ts";
import { findParent } from "../../core/html.ts";
import { createHtmlPresentationFormat } from "../formats-shared.ts";
import { pandocFormatWith } from "../../core/pandoc/pandoc-formats.ts";
import { htmlFormatExtras } from "../html/format-html.ts";
import {
  revealPluginExtras,
  RevealPluginScript,
} from "./format-reveal-plugin.ts";
import { revealTheme } from "./format-reveal-theme.ts";
import {
  revealMuliplexPreviewFile,
  revealMultiplexExtras,
} from "./format-reveal-multiplex.ts";
import {
  insertFootnotesTitle,
  removeFootnoteBacklinks,
} from "../html/format-html-shared.ts";
import {
  HtmlPostProcessResult,
  kHtmlEmptyPostProcessResult,
} from "../../command/render/types.ts";

const kRevealOptions = [
  "controls",
  "controlsTutorial",
  "controlsLayout",
  "controlsBackArrows",
  "progress",
  "slideNumber",
  "showSlideNumber",
  "hash",
  "hashOneBasedIndex",
  "respondToHashChanges",
  "history",
  "keyboard",
  "overview",
  "disableLayout",
  "center",
  "touch",
  "loop",
  "rtl",
  "navigationMode",
  "shuffle",
  "fragments",
  "fragmentInURL",
  "embedded",
  "help",
  "pause",
  "showNotes",
  "autoPlayMedia",
  "preloadIframes",
  "autoAnimate",
  "autoAnimateMatcher",
  "autoAnimateEasing",
  "autoAnimateDuration",
  "autoAnimateUnmatched",
  "autoAnimateStyles",
  "autoSlide",
  "autoSlideStoppable",
  "autoSlideMethod",
  "defaultTiming",
  "mouseWheel",
  "display",
  "hideInactiveCursor",
  "hideCursorTime",
  "previewLinks",
  "transition",
  "transitionSpeed",
  "backgroundTransition",
  "viewDistance",
  "mobileViewDistance",
  "parallaxBackgroundImage",
  "parallaxBackgroundSize",
  "parallaxBackgroundHorizontal",
  "parallaxBackgroundVertical",
  "width",
  "height",
  "margin",
  "minScale",
  "maxScale",
  "mathjax",
  "pdfSeparateFragments",
  "pdfPageHeightOffset",
];

const kRevealKebabOptions = optionsToKebab(kRevealOptions);

export const kRevealJsUrl = "revealjs-url";
export const kRevealJsConfig = "revealjs-config";

export const kSlideLogo = "logo";
export const kSlideFooter = "footer";
export const kHashType = "hash-type";
export const kScrollable = "scrollable";
export const kSmaller = "smaller";
export const kCenterTitleSlide = "center-title-slide";
export const kControlsAuto = "controlsAuto";
export const kPreviewLinksAuto = "previewLinksAuto";
export const kPdfSeparateFragments = "pdfSeparateFragments";
export const kAutoAnimateEasing = "autoAnimateEasing";
export const kAutoAnimateDuration = "autoAnimateDuration";
export const kAutoAnimateUnmatched = "autoAnimateUnmatched";
export const kAutoStretch = "auto-stretch";

export function optionsToKebab(options: string[]) {
  return options.reduce(
    (options: string[], option: string) => {
      const kebab = camelToKebab(option);
      if (kebab !== option) {
        options.push(kebab);
      }
      return options;
    },
    [],
  );
}

export function revealResolveFormat(format: Format) {
  format.metadata = revealMetadataFilter(format.metadata);

  // map "vertical" navigation mode to "default"
  if (format.metadata["navigationMode"] === "vertical") {
    format.metadata["navigationMode"] = "default";
  }
}

export function revealMetadataFilter(
  metadata: Metadata,
  kebabOptions = kRevealKebabOptions,
) {
  // convert kebab case to camel case for reveal options
  const filtered: Metadata = {};
  Object.keys(metadata).forEach((key) => {
    const value = metadata[key];
    if (
      kebabOptions.includes(key)
    ) {
      filtered[kebabToCamel(key)] = value;
    } else {
      filtered[key] = value;
    }
  });
  return filtered;
}

export function revealjsFormat() {
  return mergeConfigs(
    createHtmlPresentationFormat(10, 5),
    {
      pandoc: {
        [kHtmlMathMethod]: {
          method: "mathjax",
          url:
            "https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.0/MathJax.js?config=TeX-AMS_HTML-full",
        },
        [kSlideLevel]: 2,
      },
      render: {
        [kCodeLineNumbers]: true,
      },
      metadata: {
        [kAutoStretch]: true,
      },
      resolveFormat: revealResolveFormat,
      formatPreviewFile: revealMuliplexPreviewFile,
      formatExtras: async (
        input: string,
        flags: PandocFlags,
        format: Format,
        libDir: string,
        temp: TempContext,
        offset: string,
      ) => {
        // render styles template based on options
        const stylesFile = temp.createFile({ suffix: ".html" });
        const styles = renderEjs(
          formatResourcePath("revealjs", "styles.html"),
          { [kScrollable]: format.metadata[kScrollable] },
        );
        Deno.writeTextFileSync(stylesFile, styles);

        // specify controlsAuto if there is no boolean 'controls'
        const metadataOverride: Metadata = {};
        const controlsAuto = typeof (format.metadata["controls"]) !== "boolean";
        if (controlsAuto) {
          metadataOverride.controls = false;
        }

        // specify previewLinksAuto if there is no boolean 'previewLinks'
        const previewLinksAuto = format.metadata["previewLinks"] === "auto";
        if (previewLinksAuto) {
          metadataOverride.previewLinks = false;
        }

        // additional options not supported by pandoc
        const extraConfig: Record<string, unknown> = {
          [kControlsAuto]: controlsAuto,
          [kPreviewLinksAuto]: previewLinksAuto,
          [kSmaller]: !!format.metadata[kSmaller],
          [kPdfSeparateFragments]: !!format.metadata[kPdfSeparateFragments],
          [kAutoAnimateEasing]: format.metadata[kAutoAnimateEasing] || "ease",
          [kAutoAnimateDuration]: format.metadata[kAutoAnimateDuration] ||
            1.0,
          [kAutoAnimateUnmatched]:
            format.metadata[kAutoAnimateUnmatched] !== undefined
              ? format.metadata[kAutoAnimateUnmatched]
              : true,
        };

        // get theme info (including text highlighing mode)
        const theme = await revealTheme(format, input, libDir, temp);

        const revealPluginData = await revealPluginExtras(
          format,
          flags,
          temp,
          theme.revealUrl,
          theme.revealDestDir,
        );

        // start with html format extras and our standard  & plugin extras
        let extras = mergeConfigs(
          // extras for all html formats
          await htmlFormatExtras(input, flags, offset, format, temp, {
            tabby: true,
            anchors: false,
            copyCode: true,
            hoverCitations: true,
            hoverFootnotes: true,
            figResponsive: false,
          }, // tippy options
          {
            theme: "quarto-reveal",
            parent: "section.slide",
            config: {
              offset: [0, 0],
              maxWidth: 700,
            },
          }, {
            quartoBase: false,
          }),
          // default extras for reveal
          {
            args: [],
            pandoc: {},
            metadata: {
              [kLinkCitations]: true,
            } as Metadata,
            metadataOverride,
            templateContext: {
              template: join(
                formatResourcePath("revealjs", "pandoc"),
                "template.revealjs",
              ),
              partials: [],
            },

            [kIncludeInHeader]: [
              formatResourcePath("html", "styles-callout.html"),
              stylesFile,
            ],
            html: {
              [kHtmlPostprocessors]: [
                revealHtmlPostprocessor(
                  format,
                  extraConfig,
                  revealPluginData.pluginInit,
                ),
              ],
              [kMarkdownAfterBody]: [revealMarkdownAfterBody(format)],
            },
          },
        );

        extras.metadataOverride = {
          ...extras.metadataOverride,
          ...theme.metadata,
        };
        extras.html![kTextHighlightingMode] = theme[kTextHighlightingMode];

        // add plugins
        extras = mergeConfigs(
          revealPluginData.extras,
          extras,
        );

        // add multiplex if we have it
        const multiplexExtras = revealMultiplexExtras(format);
        if (multiplexExtras) {
          extras = mergeConfigs(extras, multiplexExtras);
        }

        // provide alternate defaults unless the user requests revealjs defaults
        if (format.metadata[kRevealJsConfig] !== "default") {
          // detect whether we are using vertical slides
          const navigationMode = format.metadata["navigationMode"];
          const verticalSlides = navigationMode === "default" ||
            navigationMode === "grid";

          // if the user set slideNumber to true then provide
          // linear slides (if they havne't specified vertical slides)
          if (format.metadata["slideNumber"] === true) {
            extras.metadataOverride!["slideNumber"] = verticalSlides
              ? "h.v"
              : "c/t";
          }

          // opinionated version of reveal config defaults
          extras.metadata = {
            ...extras.metadata,
            ...revealMetadataFilter({
              width: 1050,
              height: 700,
              margin: 0.1,
              center: false,
              navigationMode: "linear",
              controlsLayout: "edges",
              controlsTutorial: false,
              hash: true,
              history: true,
              hashOneBasedIndex: false,
              fragmentInURL: false,
              transition: "none",
              backgroundTransition: "none",
              pdfSeparateFragments: false,
            }),
          };
        }

        // hash-type: number (as shorthand for -auto_identifiers)
        if (format.metadata[kHashType] === "number") {
          extras.pandoc = {
            ...extras.pandoc,
            from: pandocFormatWith(
              format.pandoc[kFrom] || "markdown",
              "",
              "-auto_identifiers",
            ),
          };
        }

        // return extras
        return extras;
      },
    },
  );
}

function revealMarkdownAfterBody(format: Format) {
  const lines: string[] = [];
  if (format.metadata[kSlideLogo]) {
    lines.push(
      `<img src="${format.metadata[kSlideLogo]}" class="slide-logo" />`,
    );
    lines.push("\n");
  }
  lines.push("::: {.footer .footer-default}");
  if (format.metadata[kSlideFooter]) {
    lines.push(String(format.metadata[kSlideFooter]));
  } else {
    lines.push("");
  }
  lines.push(":::");
  lines.push("\n");

  return lines.join("\n");
}

const kOutputLocationSlide = "output-location-slide";
const kRevealJsPlugins = " reveal.js plugins ";
/*
    // plugin scripts

    const scriptTags = scripts.map((file) => {
      const async = file.async ? " async" : "";
      return `  <script src="${file.path}"${async}></script>`;
    }).join("\n");
    template = template.replace(
      kRevealJsPlugins,
      kRevealJsPlugins + "\n" + scriptTags,
    );
    */

function revealHtmlPostprocessor(
  format: Format,
  extraConfig: Record<string, unknown>,
  pluginInit: {
    scripts: RevealPluginScript[];
    register: string[];
    revealConfig: Record<string, unknown>;
  },
) {
  return (doc: Document): Promise<HtmlPostProcessResult> => {
    // determine if we are embedding footnotes on slides
    const slideFootnotes = format.pandoc[kReferenceLocation] !== "document";

    // compute slide level and slide headings
    const slideLevel = format.pandoc[kSlideLevel] || 2;
    const slideHeadingTags = Array.from(Array(slideLevel)).map((_e, i) =>
      "H" + (i + 1)
    );

    // find output-location-slide and inject slides as required
    const slideOutputs = doc.querySelectorAll(`.${kOutputLocationSlide}`);
    for (const slideOutput of slideOutputs) {
      // find parent slide
      const slideOutputEl = slideOutput as Element;
      const parentSlide = findParentSlide(slideOutputEl);
      if (parentSlide && parentSlide.parentElement) {
        const newSlide = doc.createElement("section");
        newSlide.id = parentSlide?.id ? parentSlide.id + "-output" : "";
        for (const clz of parentSlide.classList) {
          newSlide.classList.add(clz);
        }
        newSlide.classList.add(kOutputLocationSlide);
        // repeat header if there is one
        if (
          slideHeadingTags.includes(
            parentSlide.firstElementChild?.tagName || "",
          )
        ) {
          const headingEl = doc.createElement(
            parentSlide.firstElementChild?.tagName!,
          );
          headingEl.innerHTML = parentSlide.firstElementChild?.innerHTML || "";
          newSlide.appendChild(headingEl);
        }
        newSlide.appendChild(slideOutputEl);
        parentSlide.parentElement.appendChild(newSlide);
      }
    }

    // if we are using 'number' as our hash type then remove the
    // title slide id
    if (format.metadata[kHashType] === "number") {
      const titleSlide = doc.getElementById("title-slide");
      if (titleSlide) {
        titleSlide.removeAttribute("id");
      }
    }

    // Find the plugin comment marker
    let scriptPositionNode;
    const rootNodes = doc.querySelector("body")?.childNodes;
    if (rootNodes) {
      for (const node of rootNodes) {
        if (node.nodeType === NodeType.COMMENT_NODE) {
          if (node.nodeValue === kRevealJsPlugins) {
            scriptPositionNode = node;
            break;
          }
        }
      }
    }

    // Add reveal plugin script tags
    if (scriptPositionNode) {
      const createPluginScript = (pluginScript: RevealPluginScript) => {
        const el = doc.createElement("script");
        el.setAttribute("src", pluginScript.path);
        if (pluginScript.async) {
          el.setAttribute("async", "");
        }

        const spacing = doc.createTextNode("  ");
        const newLine = doc.createTextNode("\n");

        return [spacing, el, newLine];
      };
      const els = pluginInit.scripts.flatMap((script) => {
        return createPluginScript(script);
      });
      const newLine = doc.createTextNode("\n");
      scriptPositionNode.after(newLine, ...els);
    } else {
      throw new Error(
        "Unable to determine where to insert Reveal plugin initialization scripts",
      );
    }

    // find reveal initialization and perform fixups
    const scripts = doc.querySelectorAll("script");
    for (const script of scripts) {
      const scriptEl = script as Element;
      if (
        scriptEl.innerText &&
        scriptEl.innerText.indexOf("Reveal.initialize({") !== -1
      ) {
        // quote slideNumber
        scriptEl.innerText = scriptEl.innerText.replace(
          /slideNumber: (h[\.\/]v|c(?:\/t)?)/,
          "slideNumber: '$1'",
        );

        // plugin registration
        if (pluginInit.register.length > 0) {
          const kRevealPluginArray = "plugins: [";
          scriptEl.innerText = scriptEl.innerText.replace(
            kRevealPluginArray,
            kRevealPluginArray + pluginInit.register.join(", ") + ",\n",
          );
        }

        // Write any additional configuration of reveal
        const configJs: string[] = [];
        Object.keys(extraConfig).forEach((key) => {
          configJs.push(
            `'${key}': ${JSON.stringify(extraConfig[key])}`,
          );
        });

        // Plugin initialization
        Object.keys(pluginInit.revealConfig).forEach((key) => {
          configJs.push(
            `'${key}': ${JSON.stringify(pluginInit.revealConfig[key])}`,
          );
        });

        const configStr = configJs.join(",\n");

        scriptEl.innerText = scriptEl.innerText.replace(
          "Reveal.initialize({",
          `Reveal.initialize({\n${configStr},\n`,
        );
      }
    }

    // remove slides with data-visibility=hidden
    const invisibleSlides = doc.querySelectorAll(
      'section.slide[data-visibility="hidden"]',
    );
    for (let i = (invisibleSlides.length - 1); i >= 0; i--) {
      const slide = invisibleSlides.item(i);
      // remove from toc
      const id = (slide as Element).id;
      if (id) {
        const tocEntry = doc.querySelector(
          'nav[role="doc-toc"] a[href="#/' + id + '"]',
        );
        if (tocEntry) {
          tocEntry.parentNode?.remove();
        }
      }

      // remove slide
      slide.parentNode?.removeChild(slide);
    }

    // remove all attributes from slide headings (pandoc has already moved
    // them to the enclosing section)
    const slideHeadings = doc.querySelectorAll("section.slide > :first-child");
    slideHeadings.forEach((slideHeading) => {
      const slideHeadingEl = slideHeading as Element;
      if (slideHeadingTags.includes(slideHeadingEl.tagName)) {
        // remove attributes
        for (const attrib of slideHeadingEl.getAttributeNames()) {
          slideHeadingEl.removeAttribute(attrib);
          // if it's auto-animate then do some special handling
          if (attrib === "data-auto-animate") {
            // link slide titles for animation
            slideHeadingEl.setAttribute("data-id", "quarto-animate-title");
            // add animation id to code blocks
            const codeBlocks = slideHeadingEl.parentElement?.querySelectorAll(
              "div.sourceCode > pre > code",
            );
            if (codeBlocks?.length === 1) {
              const codeEl = codeBlocks.item(0) as Element;
              const preEl = codeEl.parentElement!;
              preEl.setAttribute(
                "data-id",
                "quarto-animate-code",
              );
              // markup with highlightjs classes so that are sucessfully targeted by
              // autoanimate.js
              codeEl.classList.add("hljs");
              codeEl.childNodes.forEach((spanNode) => {
                if (spanNode.nodeType === NodeType.ELEMENT_NODE) {
                  const spanEl = spanNode as Element;
                  spanEl.classList.add("hljs-ln-code");
                }
              });
            }
          }
        }
      }
    });

    // center title slide if requested
    // note that disabling title slide centering when the rest of the
    // slides are centered doesn't currently work b/c reveal consults
    // the global 'center' config as well as the class. to overcome
    // this we'd need to always set 'center: false` and then
    // put the .center classes onto each slide manually. we're not
    // doing this now the odds a user would want all of their
    // slides cnetered but NOT the title slide are close to zero
    if (format.metadata[kCenterTitleSlide] !== false) {
      const titleSlide = doc.getElementById("title-slide") as Element;
      if (titleSlide) {
        titleSlide.classList.add("center");
      }
      const titleSlides = doc.querySelectorAll(".title-slide");
      for (const slide of titleSlides) {
        (slide as Element).classList.add("center");
      }
    }

    // inject css to hide assistive mml in speaker notes (have to do it for each aside b/c the asides are
    // slurped into speaker mode one at a time using innerHTML) note that we can remvoe this hack when we begin
    // defaulting to MathJax 3 (after Pandoc updates their template to support Reveal 4.2 / MathJax 3)
    // see discussion of underlying issue here: https://github.com/hakimel/reveal.js/issues/1726
    // hack here: https://stackoverflow.com/questions/35534385/mathjax-config-for-web-mobile-and-assistive
    const notes = doc.querySelectorAll("aside.notes");
    for (const note of notes) {
      const style = doc.createElement("style");
      style.setAttribute("type", "text/css");
      style.innerHTML = `
        span.MJX_Assistive_MathML {
          position:absolute!important;
          clip: rect(1px, 1px, 1px, 1px);
          padding: 1px 0 0 0!important;
          border: 0!important;
          height: 1px!important;
          width: 1px!important;
          overflow: hidden!important;
          display:block!important;
      }`;
      note.appendChild(style);
    }

    // collect up asides into a single aside
    const slides = doc.querySelectorAll("section.slide");
    for (const slide of slides) {
      const slideEl = slide as Element;
      const asides = slideEl.querySelectorAll("aside:not(.notes)");
      const asideDivs = slideEl.querySelectorAll("div.aside");
      const footnotes = slideEl.querySelectorAll('a[role="doc-noteref"]');
      if (asides.length > 0 || asideDivs.length > 0 || footnotes.length > 0) {
        const aside = doc.createElement("aside");
        // deno-lint-ignore no-explicit-any
        const collectAsides = (asideList: any) => {
          asideList.forEach((asideEl: Element) => {
            const asideDiv = doc.createElement("div");
            asideDiv.innerHTML = (asideEl as Element).innerHTML;
            aside.appendChild(asideDiv);
          });
          asideList.forEach((asideEl: Element) => {
            asideEl.remove();
          });
        };
        // start with asides and div.aside
        collectAsides(asides);
        collectAsides(asideDivs);

        // append footnotes
        if (slideFootnotes && footnotes.length > 0) {
          const ol = doc.createElement("ol");
          ol.classList.add("aside-footnotes");
          footnotes.forEach((note, index) => {
            const noteEl = note as Element;
            const href = noteEl.getAttribute("href");
            if (href) {
              const noteLi = doc.getElementById(href.replace(/^#\//, ""));
              if (noteLi) {
                // remove backlink
                const footnoteBack = noteLi.querySelector(".footnote-back");
                if (footnoteBack) {
                  footnoteBack.remove();
                }
                ol.appendChild(noteLi);
              }
            }
            const sup = doc.createElement("sup");
            sup.innerText = (index + 1) + "";
            noteEl.replaceWith(sup);
          });
          aside.appendChild(ol);
        }

        slide.appendChild(aside);
      }
    }

    const footnotes = doc.querySelectorAll('section[role="doc-endnotes"]');
    if (slideFootnotes) {
      // we are using slide based footnotes so remove footnotes slide from end
      for (const footnoteSection of footnotes) {
        footnoteSection.remove();
      }
    } else {
      // we are keeping footnotes at the end so disable the links (we use popups)
      // and tweak the footnotes slide (add a title add smaller/scrollable)
      const notes = doc.querySelectorAll('a[role="doc-noteref"]');
      for (const note of notes) {
        const noteEl = note as Element;
        noteEl.setAttribute("onclick", "return false;");
      }
      const footnotes = doc.querySelectorAll('section[role="doc-endnotes"]');
      if (footnotes.length === 1) {
        const footnotesEl = footnotes[0] as Element;
        insertFootnotesTitle(doc, footnotesEl, format.language, slideLevel);
        footnotesEl.classList.add("smaller");
        footnotesEl.classList.add("scrollable");
        footnotesEl.classList.remove("center");
        removeFootnoteBacklinks(footnotesEl);
      }
    }

    // disable citation links (we use a popup for them)
    const cites = doc.querySelectorAll('a[role="doc-biblioref"]');
    for (const cite of cites) {
      const citeEl = cite as Element;
      citeEl.setAttribute("onclick", "return false;");
    }

    // add scrollable to refs slide
    const refs = doc.querySelector("#refs");
    if (refs) {
      applyClassesToParentSlide(refs, ["smaller", "scrollable"]);
      removeClassesFromParentSlide(refs, ["center"]);
    }

    // apply stretch to images as required
    applyStretch(doc, format.metadata[kAutoStretch] as boolean);

    return Promise.resolve(kHtmlEmptyPostProcessResult);
  };
}

function applyStretch(doc: Document, autoStretch: boolean) {
  // Add stretch class to images in slides with only one image
  const allSlides = doc.querySelectorAll("section.slide");
  for (const slide of allSlides) {
    const slideEl = slide as Element;

    // opt-out mechanism per slide
    if (slideEl.classList.contains("nostretch")) continue;

    const images = slideEl.querySelectorAll("img");
    // only target slides with one image
    if (images.length === 1) {
      const image = images[0];
      const imageEl = image as Element;

      // screen out images inside layout panels and columns
      if (
        findParent(imageEl, (el: Element) => {
          return el.classList.contains("column") ||
            el.classList.contains("quarto-layout-panel") ||
            el.classList.contains("fragment") ||
            el.classList.contains(kOutputLocationSlide) ||
            !!el.className.match(/panel-/);
        })
      ) {
        continue;
      }

      // find the first level node that contains the img
      let selNode: Element | undefined;
      for (const node of slide.childNodes) {
        if (node.contains(image)) {
          selNode = node as Element;
          break;
        }
      }
      const nodeEl = selNode;

      // Do not apply stretch if this is an inline image among text
      if (
        !nodeEl || (nodeEl.nodeName === "P" && nodeEl.childNodes.length > 1)
      ) {
        continue;
      }

      // add stretch class if not already when auto-stretch is set
      const hasStretchClass = function (imageEl: Element): boolean {
        return imageEl.classList.contains("stretch") ||
          imageEl.classList.contains("r-stretch");
      };
      if (
        autoStretch === true &&
        !hasStretchClass(imageEl) &&
        // if height is already set, we do nothing
        !imageEl.getAttribute("style")?.match("height:") &&
        !imageEl.hasAttribute("height")
      ) {
        imageEl.classList.add("r-stretch");
      }
      // If <img class="stetch"> is not a direct child of <section>, move it
      if (
        hasStretchClass(imageEl) &&
        imageEl.parentNode?.nodeName !== "SECTION"
      ) {
        // Remove element then maybe remove its parents if empty
        const removeEmpty = function (el: Element) {
          const parentEl = el.parentElement;
          parentEl?.removeChild(el);
          if (parentEl?.innerText.trim() === "") removeEmpty(parentEl);
        };

        // Figure environment ? Get caption and alignment
        const quartoFig = slideEl.querySelector("div.quarto-figure");
        const caption = doc.createElement("p");
        if (quartoFig) {
          // Get alignment
          const align = quartoFig.className.match(
            "quarto-figure-(center|left|right)",
          );
          if (align) imageEl.classList.add(align[0]);
          // Get Caption
          const figCaption = nodeEl.querySelector("figcaption");
          if (figCaption) {
            caption.classList.add("caption");
            caption.innerHTML = figCaption.innerHTML;
          }
        }

        // Target position of image
        // first level after the element
        const nextEl = nodeEl.nextElementSibling;
        // Remove image from its parent
        removeEmpty(imageEl);
        // insert at target position
        slideEl.insertBefore(image, nextEl);

        // If there was a caption processed add it after
        if (caption.classList.contains("caption")) {
          slideEl.insertBefore(
            caption,
            imageEl.nextElementSibling,
          );
        }
        // Remove container if still there
        if (quartoFig) removeEmpty(quartoFig);
      }
    }
  }
}

function applyClassesToParentSlide(
  el: Element,
  classes: string[],
  slideClass = "slide",
) {
  const slideEl = findParentSlide(el, slideClass);
  if (slideEl) {
    classes.forEach((clz) => slideEl.classList.add(clz));
  }
}

function removeClassesFromParentSlide(
  el: Element,
  classes: string[],
  slideClass = "slide",
) {
  const slideEl = findParentSlide(el, slideClass);
  if (slideEl) {
    classes.forEach((clz) => slideEl.classList.remove(clz));
  }
}

function findParentSlide(el: Element, slideClass = "slide") {
  return findParent(el, (el: Element) => {
    return el.classList.contains(slideClass);
  });
}
