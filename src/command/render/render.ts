/*
* render.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { existsSync } from "fs/mod.ts";

import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
} from "path/mod.ts";

import * as ld from "../../core/lodash.ts";

import { Document, DOMParser, initDenoDom } from "../../core/deno-dom.ts";

import { error, info } from "log/mod.ts";

import { mergeConfigs } from "../../core/config.ts";
import { resourcePath } from "../../core/resources.ts";
import { figuresDir, inputFilesDir } from "../../core/render.ts";
import {
  dirAndStem,
  pathWithForwardSlashes,
  removeIfEmptyDir,
  removeIfExists,
} from "../../core/path.ts";
import { warnOnce } from "../../core/log.ts";

import {
  formatFromMetadata,
  formatKeys,
  includedMetadata,
  mergeFormatMetadata,
  metadataAsFormat,
} from "../../config/metadata.ts";
import {
  kBibliography,
  kCache,
  kCss,
  kDate,
  kDateFormat,
  kDateFormatted,
  kEcho,
  kEngine,
  kExecuteDaemon,
  kExecuteDaemonRestart,
  kExecuteDebug,
  kExecuteEnabled,
  kFreeze,
  kHeaderIncludes,
  kIncludeAfter,
  kIncludeAfterBody,
  kIncludeBefore,
  kIncludeBeforeBody,
  kIncludeInHeader,
  kKeepMd,
  kLang,
  kMetadataFormat,
  kOutputExt,
  kOutputFile,
  kSelfContained,
  kServer,
  kTheme,
} from "../../config/constants.ts";
import { Format, FormatPandoc } from "../../config/types.ts";
import {
  executionEngine,
  executionEngineKeepMd,
  fileExecutionEngineAndTarget,
} from "../../execute/engine.ts";

import { defaultWriterFormat } from "../../format/formats.ts";

import { formatHasBootstrap } from "../../format/html/format-html-bootstrap.ts";

import {
  HtmlPostProcessResult,
  PandocOptions,
  RenderFile,
  RenderFlags,
} from "./types.ts";
import { runPandoc } from "./pandoc.ts";
import { removePandocToArg, resolveParams } from "./flags.ts";
import { renderCleanup } from "./cleanup.ts";
import { outputRecipe } from "./output.ts";
import {
  kProjectLibDir,
  kProjectType,
  ProjectContext,
} from "../../project/types.ts";
import { projectOffset } from "../../project/project-shared.ts";
import {
  deleteProjectMetadata,
  directoryMetadataForInputFile,
  projectMetadataForInputFile,
  projectTypeIsWebsite,
} from "../../project/project-context.ts";
import { projectType } from "../../project/types/project-types.ts";

import {
  copyFromProjectFreezer,
  copyToProjectFreezer,
  defrostExecuteResult,
  freezeExecuteResult,
  freezerFigsDir,
  freezerFreezeFile,
  kProjectFreezeDir,
  removeFreezeResults,
} from "./freeze.ts";
import { ojsExecuteResult } from "../../execute/ojs/compile.ts";
import { annotateOjsLineNumbers } from "../../execute/ojs/annotate-source.ts";
import {
  ExecutedFile,
  PandocRenderer,
  RenderContext,
  RenderedFile,
  RenderExecuteOptions,
  RenderFilesResult,
  RenderOptions,
  RenderResult,
} from "./types.ts";
import {
  ExecuteResult,
  ExecutionEngine,
  ExecutionTarget,
  PandocIncludes,
} from "../../execute/types.ts";
import { Metadata } from "../../config/types.ts";
import {
  isHtmlCompatible,
  isHtmlFileOutput,
  isHtmlOutput,
} from "../../config/format.ts";
import { resolveLanguageMetadata } from "../../core/language.ts";

import {
  validateDocument,
  validateDocumentFromSource,
} from "../../core/schema/validate-document.ts";

import { getFrontMatterSchema } from "../../core/lib/yaml-schema/front-matter.ts";
import { renderProgress } from "./render-shared.ts";
import { createTempContext } from "../../core/temp.ts";
import { YAMLValidationError } from "../../core/yaml.ts";
import {
  formatDate,
  isSpecialDate,
  parsePandocDate,
  parseSpecialDate,
  setDateLocale,
} from "../../core/date.ts";

export async function renderFiles(
  files: RenderFile[],
  options: RenderOptions,
  alwaysExecuteFiles?: string[],
  pandocRenderer?: PandocRenderer,
  project?: ProjectContext,
): Promise<RenderFilesResult> {
  // provide default renderer
  pandocRenderer = pandocRenderer || defaultPandocRenderer(options, project);

  // create temp context
  const tempContext = createTempContext();

  try {
    // make a copy of options so we don't mutate caller context
    options = ld.cloneDeep(options);

    // see if we should be using file-by-file progress
    const progress = options.progress ||
      (project && (files.length > 1) && !options.flags?.quiet);

    // quiet pandoc output if we are doing file by file progress
    const pandocQuiet = !!progress;

    // calculate num width
    const numWidth = String(files.length).length;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (progress) {
        renderProgress(
          `[${String(i + 1).padStart(numWidth)}/${files.length}] ${
            relative(project!.dir, file.path)
          }`,
        );
      }

      // get contexts
      let contexts: Record<string, RenderContext> | undefined;
      try {
        contexts = await renderContexts(
          file,
          options,
          true,
          project,
        );
      } catch (e) {
        // bad YAML can cause failure before validation. We
        // reconstruct the context as best we can and try to validate.
        // note that this ignores "validate-yaml: false"
        const { engine, target } = await fileExecutionEngineAndTarget(
          file.path,
          options.flags?.quiet,
        );
        const validationResult = await validateDocumentFromSource(
          target.markdown,
          engine.name,
          error,
          file.path,
        );
        if (validationResult.length) {
          throw new RenderInvalidYAMLError();
        } else {
          // rethrow if no validation error happened.
          throw e;
        }
      }

      for (const format of Object.keys(contexts)) {
        const context = contexts[format];

        // Set the date locale for this render
        // Used for date formatting
        await setDateLocale(context.format.metadata[kLang] as string);

        // one time denoDom init for html compatible formats
        if (isHtmlCompatible(context.format)) {
          await initDenoDom();
        }

        // get output recipe
        const recipe = await outputRecipe(context);

        // determine execute options
        const executeOptions = mergeConfigs(
          {
            alwaysExecute: alwaysExecuteFiles?.includes(file.path),
          },
          pandocRenderer.onBeforeExecute(recipe.format),
        );

        const validate = context.format.metadata?.["validate-yaml"];
        if (validate !== false) {
          const validationResult = await validateDocument(context);
          if (validationResult.length) {
            throw new RenderInvalidYAMLError();
          }
        }

        // FIXME it should be possible to infer this directly now
        // based on the information in the mapped strings.
        //
        // collect line numbers to facilitate runtime error reporting
        const { ojsBlockLineNumbers } = annotateOjsLineNumbers(context);

        // execute
        const baseExecuteResult = await renderExecute(
          context,
          recipe.output,
          executeOptions,
        );

        // process ojs
        const { executeResult, resourceFiles } = await ojsExecuteResult(
          context,
          baseExecuteResult,
          ojsBlockLineNumbers,
        );

        // callback
        await pandocRenderer.onRender(format, {
          context,
          recipe,
          executeResult,
          resourceFiles,
        }, pandocQuiet);
      }
    }

    if (progress) {
      info("");
    }

    return await pandocRenderer.onComplete(false, options.flags?.quiet);
  } catch (error) {
    return {
      files: (await pandocRenderer.onComplete(true)).files,
      error: error || new Error(),
    };
  } finally {
    tempContext.cleanup();
  }
}

export async function renderContexts(
  file: RenderFile,
  options: RenderOptions,
  forExecute: boolean,
  project?: ProjectContext,
): Promise<Record<string, RenderContext>> {
  // clone options (b/c we will modify them)
  options = ld.cloneDeep(options) as RenderOptions;

  const { engine, target } = await fileExecutionEngineAndTarget(
    file.path,
    options.flags?.quiet,
  );

  // resolve render target
  const formats = await resolveFormats(file, target, engine, options, project);

  // remove --to (it's been resolved into contexts)
  options = removePandocTo(options);

  // see if there is a libDir
  let libDir = project?.config?.project[kProjectLibDir];
  if (project && libDir) {
    libDir = relative(dirname(file.path), join(project.dir, libDir));
  } else {
    libDir = filesDirLibDir(file.path);
  }

  // return contexts
  const contexts: Record<string, RenderContext> = {};
  Object.keys(formats).forEach((format: string) => {
    // set format
    contexts[format] = {
      target,
      options,
      engine,
      format: formats[format],
      project,
      libDir: libDir!,
    };
    // if this isn't for execute then cleanup context
    if (!forExecute && engine.executeTargetSkipped) {
      engine.executeTargetSkipped(target, formats[format]);
    }
  });
  return contexts;
}

export async function renderFormats(
  file: string,
  to = "all",
  project?: ProjectContext,
): Promise<Record<string, Format>> {
  const tempContext = createTempContext();
  try {
    const contexts = await renderContexts(
      { path: file },
      { temp: tempContext, flags: { to } },
      false,
      project,
    );
    const formats: Record<string, Format> = {};
    Object.keys(contexts).forEach((formatName) => {
      // get the format
      const context = contexts[formatName];
      const format = context.format;
      // remove other formats
      delete format.metadata.format;
      // remove project level metadata
      deleteProjectMetadata(format.metadata);
      // resolve output-file
      if (!format.pandoc[kOutputFile]) {
        const [_dir, stem] = dirAndStem(file);
        format.pandoc[kOutputFile] = `${stem}.${format.render[kOutputExt]}`;
      }
      // provide engine
      format.execute[kEngine] = context.engine.name;
      formats[formatName] = format;
    });
    return formats;
  } finally {
    tempContext.cleanup();
  }
}

export async function renderExecute(
  context: RenderContext,
  output: string,
  options: RenderExecuteOptions,
): Promise<ExecuteResult> {
  // alias options
  const { resolveDependencies = true, alwaysExecute = false } = options;

  // alias flags
  const flags = context.options.flags || {};

  // compute filesDir
  const filesDir = inputFilesDir(context.target.source);

  // compute project relative files dir (if we are in a project)
  let projRelativeFilesDir: string | undefined;
  if (context.project) {
    const inputDir = relative(
      context.project.dir,
      dirname(context.target.source),
    );
    projRelativeFilesDir = join(inputDir, filesDir);
  }

  // are we eligible to freeze?
  const canFreeze = context.engine.canFreeze &&
    (context.format.execute[kExecuteEnabled] !== false);

  // use previous frozen results if they are available
  if (context.project && !alwaysExecute) {
    // check if we are using the freezer

    const thaw = canFreeze &&
      (context.format.execute[kFreeze] ||
        (context.options.useFreezer ? "auto" : false));

    if (thaw) {
      // copy from project freezer
      const hidden = context.format.execute[kFreeze] === false;
      copyFromProjectFreezer(
        context.project,
        projRelativeFilesDir!,
        hidden,
      );

      const thawedResult = defrostExecuteResult(
        context.target.source,
        output,
        context.options.temp,
        thaw === true,
      );
      if (thawedResult) {
        // copy the site_libs dir from the freezer
        const libDir = context.project?.config?.project[kProjectLibDir];
        if (libDir) {
          copyFromProjectFreezer(context.project, libDir, hidden);
        }

        // remove the results dir
        removeFreezeResults(join(context.project.dir, projRelativeFilesDir!));

        // notify engine that we skipped execute
        if (context.engine.executeTargetSkipped) {
          context.engine.executeTargetSkipped(context.target, context.format);
        }

        // return results
        return thawedResult;
      }
    }
  }

  // calculate figsDir
  const figsDir = join(filesDir, figuresDir(context.format.pandoc.to));

  // execute computations
  const executeResult = await context.engine.execute({
    target: context.target,
    resourceDir: resourcePath(),
    tempDir: context.options.temp.createDir(),
    dependencies: resolveDependencies,
    libDir: context.libDir,
    format: context.format,
    cwd: flags.executeDir,
    params: resolveParams(flags.params, flags.paramsFile),
    quiet: flags.quiet,
  });

  // keep md if requested
  const keepMd = executionEngineKeepMd(context.target.input);
  if (keepMd && context.format.execute[kKeepMd]) {
    Deno.writeTextFileSync(keepMd, executeResult.markdown);
  }

  // write the freeze file if we are in a project
  if (context.project && canFreeze) {
    // write the freezer file
    const freezeFile = freezeExecuteResult(
      context.target.source,
      output,
      executeResult,
    );

    // always copy to the hidden freezer
    copyToProjectFreezer(context.project, projRelativeFilesDir!, true, true);

    // copy to the _freeze dir if explicit _freeze is requested
    if (context.format.execute[kFreeze] !== false) {
      copyToProjectFreezer(context.project, projRelativeFilesDir!, false, true);
    } else {
      // otherwise cleanup the _freeze subdir b/c we aren't explicitly freezing anymore

      // figs dir for this target format
      const freezeFigsDir = freezerFigsDir(
        context.project,
        projRelativeFilesDir!,
        basename(figsDir),
      );
      removeIfExists(freezeFigsDir);

      // freezer file
      const projRelativeFreezeFile = relative(context.project.dir, freezeFile);
      const freezerFile = freezerFreezeFile(
        context.project,
        projRelativeFreezeFile,
      );
      removeIfExists(freezerFile);

      // remove empty directories
      removeIfEmptyDir(dirname(freezerFile));
      removeIfEmptyDir(dirname(freezeFigsDir));
      removeIfEmptyDir(join(context.project.dir, kProjectFreezeDir));
    }

    // remove the freeze results file (now that it's safely in the freezer)
    removeFreezeResults(join(context.project.dir, projRelativeFilesDir!));
  }

  // return result
  return executeResult;
}

export async function renderPandoc(
  file: ExecutedFile,
  quiet: boolean,
): Promise<RenderedFile> {
  // alias options
  const { context, recipe, executeResult, resourceFiles } = file;

  // alias format
  const format = recipe.format;

  // merge any pandoc options provided by the computation
  if (executeResult.includes) {
    format.pandoc = mergePandocIncludes(
      format.pandoc || {},
      executeResult.includes,
    );
  }
  if (executeResult.pandoc) {
    format.pandoc = mergeConfigs(
      format.pandoc || {},
      executeResult.pandoc,
    );
  }

  // run the dependencies step if we didn't do it during execute
  if (executeResult.engineDependencies) {
    for (const engineName of Object.keys(executeResult.engineDependencies)) {
      const engine = executionEngine(engineName)!;
      const dependenciesResult = await engine.dependencies({
        target: context.target,
        format,
        output: recipe.output,
        resourceDir: resourcePath(),
        tempDir: context.options.temp.createDir(),
        libDir: context.libDir,
        dependencies: executeResult.engineDependencies[engineName],
        quiet: context.options.flags?.quiet,
      });
      format.pandoc = mergePandocIncludes(
        format.pandoc,
        dependenciesResult.includes,
      );
    }
  }

  // pandoc options
  const pandocOptions: PandocOptions = {
    markdown: executeResult.markdown,
    source: context.target.source,
    output: recipe.output,
    libDir: context.libDir,
    format,
    project: context.project,
    args: recipe.args,
    temp: context.options.temp,
    metadata: executeResult.metadata,
    quiet,
    flags: context.options.flags,
  };

  // add offset if we are in a project
  if (context.project) {
    pandocOptions.offset = projectOffset(context.project, context.target.input);
  }

  // run pandoc conversion (exit on failure)
  const pandocResult = await runPandoc(pandocOptions, executeResult.filters);
  if (!pandocResult) {
    return Promise.reject();
  }

  // run optional post-processor (e.g. to restore html-preserve regions)
  if (executeResult.postProcess) {
    await context.engine.postprocess({
      engine: context.engine,
      target: context.target,
      format,
      output: recipe.output,
      tempDir: context.options.temp.createDir(),
      preserve: executeResult.preserve,
      quiet: context.options.flags?.quiet,
    });
  }

  // run html postprocessors if we have them
  const canHtmlPostProcess = isHtmlFileOutput(format.pandoc);
  if (!canHtmlPostProcess && pandocResult.htmlPostprocessors.length > 0) {
    const postProcessorNames = pandocResult.htmlPostprocessors.map((p) =>
      p.name
    ).join(", ");
    const msg =
      `Attempt to HTML post process non HTML output using: ${postProcessorNames}`;
    throw new Error(msg);
  }
  const htmlPostProcessors = canHtmlPostProcess
    ? pandocResult.htmlPostprocessors
    : [];
  const htmlFinalizers = canHtmlPostProcess
    ? pandocResult.htmlFinalizers || []
    : [];

  const htmlPostProcessResult = await runHtmlPostprocessors(
    pandocResult.inputMetadata,
    pandocOptions,
    htmlPostProcessors,
    htmlFinalizers,
  );

  // run generic postprocessors
  if (pandocResult.postprocessors) {
    const outputFile = isAbsolute(pandocOptions.output)
      ? pandocOptions.output
      : join(dirname(pandocOptions.source), pandocOptions.output);
    for (const postprocessor of pandocResult.postprocessors) {
      await postprocessor(outputFile);
    }
  }

  // ensure flags
  const flags = context.options.flags || {};

  // call complete handler (might e.g. run latexmk to complete the render)
  const finalOutput = await recipe.complete(pandocOptions) || recipe.output;

  // determine whether this is self-contained output
  const selfContained = isSelfContainedOutput(
    flags,
    format,
    finalOutput,
  );

  // compute the relative path to the files dir
  let filesDir: string | undefined = inputFilesDir(context.target.source);
  // undefine it if it doesn't exist
  filesDir = existsSync(join(dirname(context.target.source), filesDir))
    ? filesDir
    : undefined;

  // add any injected libs to supporting
  let supporting = filesDir ? executeResult.supporting : undefined;
  if (filesDir && isHtmlFileOutput(format.pandoc)) {
    const filesDirAbsolute = join(dirname(context.target.source), filesDir);
    if (
      existsSync(filesDirAbsolute) &&
      (!supporting || !supporting.includes(filesDirAbsolute))
    ) {
      const filesLibs = join(dirname(context.target.source), context.libDir);
      if (
        existsSync(filesLibs) &&
        (!supporting || !supporting.includes(filesLibs))
      ) {
        supporting = supporting || [];
        supporting.push(filesLibs);
      }
    }
  }
  if (
    htmlPostProcessResult.supporting &&
    htmlPostProcessResult.supporting.length > 0
  ) {
    supporting = supporting || [];
    supporting.push(...htmlPostProcessResult.supporting);
  }

  renderCleanup(
    context.target.input,
    finalOutput,
    format,
    selfContained ? supporting : undefined,
    executionEngineKeepMd(context.target.input),
  );

  // if there is a project context then return paths relative to the project
  const projectPath = (path: string) => {
    if (context.project) {
      if (isAbsolute(path)) {
        return relative(
          Deno.realPathSync(context.project.dir),
          Deno.realPathSync(path),
        );
      } else {
        return relative(
          Deno.realPathSync(context.project.dir),
          Deno.realPathSync(join(dirname(context.target.source), path)),
        );
      }
    } else {
      return path;
    }
  };

  return {
    input: projectPath(context.target.source),
    markdown: executeResult.markdown,
    format,
    supporting: supporting
      ? supporting.filter(existsSync).map((file: string) =>
        context.project ? relative(context.project.dir, file) : file
      )
      : undefined,
    file: projectPath(finalOutput),
    resourceFiles: {
      globs: pandocResult.resources,
      files: resourceFiles.concat(htmlPostProcessResult.resources),
    },
    selfContained: selfContained,
  };
}

export function removePandocTo(renderOptions: RenderOptions) {
  renderOptions = ld.cloneDeep(renderOptions);
  delete renderOptions.flags?.to;
  if (renderOptions.pandocArgs) {
    renderOptions.pandocArgs = removePandocToArg(renderOptions.pandocArgs);
  }
  return renderOptions;
}

export function renderResultFinalOutput(
  renderResults: RenderResult,
  relativeToInputDir?: string,
) {
  // final output defaults to the first output of the first result
  // that isn't a supplemental render file (a file that wasn't explicitly
  // rendered but that was a side effect of rendering some other file)
  let result = renderResults.files.find((file) => {
    return !file.supplemental;
  });
  if (!result) {
    return undefined;
  }

  // see if we can find an index.html instead
  for (const fileResult of renderResults.files) {
    if (fileResult.file === "index.html" && !fileResult.supplemental) {
      result = fileResult;
      break;
    }
  }

  // determine final output
  let finalInput = result.input;
  let finalOutput = result.file;

  if (renderResults.baseDir) {
    finalInput = join(renderResults.baseDir, finalInput);
    if (renderResults.outputDir) {
      finalOutput = join(
        renderResults.baseDir,
        renderResults.outputDir,
        finalOutput,
      );
    } else {
      finalOutput = join(renderResults.baseDir, finalOutput);
    }
  } else {
    finalOutput = join(dirname(finalInput), finalOutput);
  }

  // if the final output doesn't exist then we must have been targetin stdout,
  // so return undefined
  if (!existsSync(finalOutput)) {
    return undefined;
  }

  // return a path relative to the input file
  if (relativeToInputDir) {
    const inputRealPath = Deno.realPathSync(relativeToInputDir);
    const outputRealPath = Deno.realPathSync(finalOutput);
    return relative(inputRealPath, outputRealPath);
  } else {
    return finalOutput;
  }
}

export function renderResultUrlPath(renderResult: RenderResult) {
  if (renderResult.baseDir && renderResult.outputDir) {
    const finalOutput = renderResultFinalOutput(renderResult);
    if (finalOutput) {
      const targetPath = pathWithForwardSlashes(relative(
        join(renderResult.baseDir, renderResult.outputDir),
        finalOutput,
      ));
      return targetPath;
    }
  }
  return undefined;
}

// default pandoc renderer immediately renders each execute result
function defaultPandocRenderer(
  _options: RenderOptions,
  _project?: ProjectContext,
): PandocRenderer {
  const renderedFiles: RenderedFile[] = [];

  return {
    onBeforeExecute: (_format: Format) => ({}),

    onRender: async (
      _format: string,
      executedFile: ExecutedFile,
      quiet: boolean,
    ) => {
      renderedFiles.push(await renderPandoc(executedFile, quiet));
    },
    onComplete: async () => {
      return {
        files: await Promise.resolve(renderedFiles),
      };
    },
  };
}

function mergePandocIncludes(
  format: FormatPandoc,
  pandocIncludes: PandocIncludes,
) {
  return mergeConfigs(format, pandocIncludes);
}

// some extensions are 'known' to be standalone/self-contained
// see https://pandoc.org/MANUAL.html#option--standalone
const kStandaloneExtensionNames = [
  "pdf",
  "epub",
  "fb2",
  "docx",
  "rtf",
  "pptx",
  "odt",
  "ipynb",
];

const kStandaloneExtensions = kStandaloneExtensionNames.map((name) =>
  `.${name}`
);

export function isSelfContained(flags: RenderFlags, format: Format) {
  return !!(flags[kSelfContained] || format.pandoc[kSelfContained]);
}

export function isSelfContainedOutput(
  flags: RenderFlags,
  format: Format,
  finalOutput: string,
) {
  return isSelfContained(flags, format) ||
    kStandaloneExtensions.includes(extname(finalOutput));
}

export function isStandaloneFormat(format: Format) {
  return kStandaloneExtensionNames.includes(format.render[kOutputExt] || "");
}

export async function resolveFormatsFromMetadata(
  metadata: Metadata,
  input: string,
  formats: string[],
  flags?: RenderFlags,
): Promise<Record<string, Format>> {
  const includeDir = dirname(input);

  // Read any included metadata files and merge in and metadata from the command
  const frontMatterSchema = await getFrontMatterSchema();
  const included = await includedMetadata(
    includeDir,
    metadata,
    frontMatterSchema,
  );
  const allMetadata = mergeQuartoConfigs(
    metadata,
    included.metadata,
    flags?.metadata || {},
  );

  // resolve any language file references
  await resolveLanguageMetadata(allMetadata, includeDir);

  // Resolve the date if there are any special
  // date specifiers
  if (isSpecialDate(allMetadata[kDate])) {
    allMetadata[kDate] = parseSpecialDate(
      input,
      allMetadata[kDate] as string,
    );
  }

  // Create a formatted version of the date
  if (allMetadata[kDate]) {
    const date = parsePandocDate(allMetadata[kDate] as string);
    allMetadata[kDateFormatted] = formatDate(date, "full");
  }

  // divide allMetadata into format buckets
  const baseFormat = metadataAsFormat(allMetadata);

  if (formats === undefined) {
    formats = formatKeys(allMetadata);
  }

  // provide a default format
  if (formats.length === 0) {
    formats.push(baseFormat.pandoc.to || baseFormat.pandoc.writer || "html");
  }

  // determine render formats
  const renderFormats: string[] = [];
  if (flags?.to === undefined || flags?.to === "all") {
    renderFormats.push(...formats);
  } else if (flags?.to === "default") {
    renderFormats.push(formats[0]);
  } else {
    renderFormats.push(...flags.to.split(","));
  }

  const resolved: Record<string, Format> = {};

  renderFormats.forEach((to) => {
    // determine the target format
    const format = formatFromMetadata(
      baseFormat,
      to,
      flags?.debug,
    );

    // merge configs
    const config = mergeFormatMetadata(baseFormat, format);

    // apply any metadata filter
    const resolveFormat = defaultWriterFormat(to).resolveFormat;
    if (resolveFormat) {
      resolveFormat(config);
    }

    // Create a formatted version of the date
    if (config.metadata[kDate]) {
      const date = parsePandocDate(config.metadata[kDate] as string);
      const format = config.metadata[kDateFormat] as string;
      config.metadata[kDateFormatted] = formatDate(date, format || "full");
    }

    // apply command line arguments

    // --no-execute-code
    if (flags?.execute !== undefined) {
      config.execute[kExecuteEnabled] = flags?.execute;
    }

    // --cache
    if (flags?.executeCache !== undefined) {
      config.execute[kCache] = flags?.executeCache;
    }

    // --execute-daemon
    if (flags?.executeDaemon !== undefined) {
      config.execute[kExecuteDaemon] = flags.executeDaemon;
    }

    // --execute-daemon-restart
    if (flags?.executeDaemonRestart !== undefined) {
      config.execute[kExecuteDaemonRestart] = flags.executeDaemonRestart;
    }

    // --execute-debug
    if (flags?.executeDebug !== undefined) {
      config.execute[kExecuteDebug] = flags.executeDebug;
    }

    resolved[to] = config;
  });

  return resolved;
}

export function filesDirLibDir(input: string) {
  return join(inputFilesDir(input), "libs");
}

async function runHtmlPostprocessors(
  inputMetadata: Metadata,
  options: PandocOptions,
  htmlPostprocessors: Array<
    (doc: Document, inputMetadata: Metadata) => Promise<HtmlPostProcessResult>
  >,
  htmlFinalizers: Array<(doc: Document) => Promise<void>>,
): Promise<HtmlPostProcessResult> {
  const postProcessResult: HtmlPostProcessResult = {
    resources: [],
    supporting: [],
  };
  if (htmlPostprocessors.length > 0 || htmlFinalizers.length > 0) {
    const outputFile = isAbsolute(options.output)
      ? options.output
      : join(dirname(options.source), options.output);
    const htmlInput = Deno.readTextFileSync(outputFile);
    const doctypeMatch = htmlInput.match(/^<!DOCTYPE.*?>/);
    const doc = new DOMParser().parseFromString(htmlInput, "text/html")!;
    for (let i = 0; i < htmlPostprocessors.length; i++) {
      const postprocessor = htmlPostprocessors[i];
      const result = await postprocessor(doc, inputMetadata);

      postProcessResult.resources.push(...result.resources);
      postProcessResult.supporting.push(...result.supporting);
    }

    // After the post processing is complete, allow any finalizers
    // an opportunity at the document
    for (let i = 0; i < htmlFinalizers.length; i++) {
      const finalizer = htmlFinalizers[i];
      await finalizer(doc);
    }

    const htmlOutput = (doctypeMatch ? doctypeMatch[0] + "\n" : "") +
      doc.documentElement?.outerHTML!;
    Deno.writeTextFileSync(outputFile, htmlOutput);
  }
  return postProcessResult;
}

async function resolveFormats(
  file: RenderFile,
  target: ExecutionTarget,
  engine: ExecutionEngine,
  options: RenderOptions,
  project?: ProjectContext,
): Promise<Record<string, Format>> {
  // input level metadata
  const inputMetadata = target.metadata;

  // directory level metadata
  const directoryMetadata = project?.dir
    ? await directoryMetadataForInputFile(
      project,
      dirname(target.input),
    )
    : {};

  // project level metadata
  const projMetadata = await projectMetadataForInputFile(
    target.input,
    options.flags,
    project,
  );

  // determine formats (treat dir format keys as part of 'input' format keys)
  let formats: string[] = [];
  const projFormatKeys = formatKeys(projMetadata);
  const dirFormatKeys = formatKeys(directoryMetadata);
  const inputFormatKeys = ld.uniq(
    formatKeys(inputMetadata).concat(dirFormatKeys),
  );
  const projType = projectType(project?.config?.project?.[kProjectType]);
  if (projType.projectFormatsOnly) {
    // if the project specifies that only project formats are
    // valid then use the project formats
    formats = projFormatKeys;
  } else if (inputFormatKeys.length > 0) {
    // if the input metadata has a format then this is an override
    // of the project so use its keys (and ignore the project)
    formats = inputFormatKeys;
    // otherwise use the project formats
  } else {
    formats = projFormatKeys;
  }

  // If the file itself has specified permissible
  // formats, filter the list of formats to only
  // include those formats
  if (file.formats) {
    formats = formats.filter((format) => {
      return file.formats?.includes(format);
    });

    // Remove any 'to' information that will force the
    // rnedering to a particular format
    options = ld.cloneDeep(options);
    delete options.flags?.to;
  }

  // resolve formats for each type of metadata
  const projFormats = await resolveFormatsFromMetadata(
    projMetadata,
    target.input,
    formats,
    options.flags,
  );

  const directoryFormats = await resolveFormatsFromMetadata(
    directoryMetadata,
    target.input,
    formats,
    options.flags,
  );

  const inputFormats = await resolveFormatsFromMetadata(
    inputMetadata,
    target.input,
    formats,
    options.flags,
  );

  // merge the formats
  const targetFormats = ld.uniq(
    Object.keys(projFormats).concat(Object.keys(directoryFormats)).concat(
      Object.keys(inputFormats),
    ),
  );

  const mergedFormats: Record<string, Format> = {};
  targetFormats.forEach((format: string) => {
    // alias formats
    const projFormat = projFormats[format];
    const directoryFormat = directoryFormats[format];
    const inputFormat = inputFormats[format];

    // resolve theme (project-level bootstrap theme always wins for web drived output)
    if (
      project && isHtmlOutput(format, true) && formatHasBootstrap(projFormat) &&
      projectTypeIsWebsite(projType)
    ) {
      if (formatHasBootstrap(inputFormat)) {
        delete inputFormat.metadata[kTheme];
      }
      if (formatHasBootstrap(directoryFormat)) {
        delete directoryFormat.metadata[kTheme];
      }
    }

    // combine user formats
    const userFormat = mergeFormatMetadata(
      projFormat || {},
      directoryFormat || {},
      inputFormat || {},
    );

    // if there is no "echo" set by the user then default
    // to false for documents with a server
    if (userFormat.execute[kEcho] === undefined) {
      if (userFormat.metadata[kServer] !== undefined) {
        userFormat.execute[kEcho] = false;
      }
    }

    // do the merge
    mergedFormats[format] = mergeFormatMetadata(
      defaultWriterFormat(format),
      userFormat,
    );
  });

  // filter on formats supported by this project
  for (const formatName of Object.keys(mergedFormats)) {
    const format: Format = mergedFormats[formatName];
    if (projType.isSupportedFormat) {
      if (!projType.isSupportedFormat(format)) {
        delete mergedFormats[formatName];
        warnOnce(
          `The ${formatName} format is not supported by ${projType.type} projects`,
        );
      }
    }
  }

  // apply engine format filters
  if (engine.filterFormat) {
    for (const format of Object.keys(mergedFormats)) {
      mergedFormats[format] = engine.filterFormat(
        target.source,
        options,
        mergedFormats[format],
      );
    }
  }

  return mergedFormats;
}

function mergeQuartoConfigs(
  config: Metadata,
  ...configs: Array<Metadata>
): Metadata {
  // copy all configs so we don't mutate them
  config = ld.cloneDeep(config);
  configs = ld.cloneDeep(configs);

  // bibliography needs to always be an array so it can be merged
  const fixupMergeableScalars = (metadata: Metadata) => {
    [
      kBibliography,
      kCss,
      kHeaderIncludes,
      kIncludeBefore,
      kIncludeAfter,
      kIncludeInHeader,
      kIncludeBeforeBody,
      kIncludeAfterBody,
    ]
      .forEach((key) => {
        if (typeof (metadata[key]) === "string") {
          metadata[key] = [metadata[key]];
        }
      });
  };

  // formats need to always be objects
  const fixupFormat = (config: Record<string, unknown>) => {
    const format = config[kMetadataFormat];
    if (typeof (format) === "string") {
      config.format = { [format]: {} };
    } else if (format instanceof Object) {
      Object.keys(format).forEach((key) => {
        if (typeof (Reflect.get(format, key)) !== "object") {
          Reflect.set(format, key, {});
        }
        fixupMergeableScalars(Reflect.get(format, key) as Metadata);
      });
    }
    fixupMergeableScalars(config);
    return config;
  };

  return mergeConfigs(
    fixupFormat(config),
    ...configs.map((c) => fixupFormat(c)),
  );
}

class RenderInvalidYAMLError extends YAMLValidationError {
  constructor() {
    super("Render failed due to invalid YAML.");
  }
}
