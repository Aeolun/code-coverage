// @ts-check
const istanbul = require('istanbul-lib-coverage')
const { join, resolve, dirname } = require('path')
const { existsSync, mkdirSync, readFileSync, writeFileSync, rmdirSync, readdirSync } = require('fs')
const execa = require('execa')
const {
  showNycInfo,
  resolveRelativePaths,
  checkAllPathsNotFound,
  tryFindingLocalFiles,
  readNycOptions,
  includeAllFiles
} = require('./task-utils')
const { fixSourcePaths } = require('./support-utils')
const { removePlaceholders } = require('./common-utils')

const debug = require('debug')('code-coverage')

// these are standard folder and file names used by NYC tools
const processWorkingDirectory = process.cwd()

// there might be custom "nyc" options in the user package.json
// see https://github.com/istanbuljs/nyc#configuring-nyc
// potentially there might be "nyc" options in other configuration files
// it allows, but for now ignore those options
const pkgFilename = join(processWorkingDirectory, 'package.json')
const pkg = existsSync(pkgFilename)
  ? JSON.parse(readFileSync(pkgFilename, 'utf8'))
  : {}
const scripts = pkg.scripts || {}
const DEFAULT_CUSTOM_COVERAGE_SCRIPT_NAME = 'coverage:report'
const customNycReportScript = scripts[DEFAULT_CUSTOM_COVERAGE_SCRIPT_NAME]

const nycReportOptions = (function getNycOption() {
  // https://github.com/istanbuljs/nyc#common-configuration-options
  const nycReportOptions = readNycOptions(processWorkingDirectory)

  if (nycReportOptions.exclude && !Array.isArray(nycReportOptions.exclude)) {
    console.error('NYC options: %o', nycReportOptions)
    throw new Error('Expected "exclude" to by an array')
  }

  if (nycReportOptions['temp-dir']) {
    nycReportOptions['temp-dir'] = resolve(nycReportOptions['temp-dir'])
  } else {
    nycReportOptions['temp-dir'] = join(processWorkingDirectory, '.nyc_output')
  }

  nycReportOptions.tempDir = nycReportOptions['temp-dir']

  if (nycReportOptions['report-dir']) {
    nycReportOptions['report-dir'] = resolve(nycReportOptions['report-dir'])
  }
  // seems nyc API really is using camel cased version
  nycReportOptions.reportDir = nycReportOptions['report-dir']

  return nycReportOptions
})()

const globalNycFilename = 'out.json'
const nycFilename = join(nycReportOptions.tempDir, globalNycFilename)

function saveCoverage(coverage, fileName = 'out.json') {
  const outputLocation = join(nycReportOptions.tempDir, fileName)
  if (!existsSync(dirname(outputLocation))) {
    mkdirSync(dirname(outputLocation), { recursive: true })
    debug('created folder %s for output coverage', nycReportOptions.tempDir)
  }

  writeFileSync(outputLocation, JSON.stringify(coverage))
}

function maybePrintFinalCoverageFiles(folder) {
  const jsonReportFilename = join(folder, 'coverage-final.json')
  if (!existsSync(jsonReportFilename)) {
    debug('Did not find final coverage file %s', jsonReportFilename)
    return
  }

  debug('Final coverage in %s', jsonReportFilename)
  const finalCoverage = JSON.parse(readFileSync(jsonReportFilename, 'utf8'))
  const finalCoverageKeys = Object.keys(finalCoverage)
  debug(
    'There are %d key(s) in %s',
    finalCoverageKeys.length,
    jsonReportFilename
  )

  finalCoverageKeys.forEach((key) => {
    const s = finalCoverage[key].s || {}
    const statements = Object.keys(s)
    const totalStatements = statements.length
    let coveredStatements = 0
    statements.forEach((statementKey) => {
      if (s[statementKey]) {
        coveredStatements += 1
      }
    })

    const hasStatements = totalStatements > 0
    const allCovered = coveredStatements === totalStatements
    const coverageStatus = hasStatements ? (allCovered ? '✅' : '⚠️') : '❓'

    debug(
      '%s %s statements covered %d/%d',
      coverageStatus,
      key,
      coveredStatements,
      totalStatements
    )
  })
}

const tasks = {
  /**
   * Clears accumulated code coverage information.
   *
   * Interactive mode with "cypress open"
   *    - running a single spec or "Run all specs" needs to reset coverage
   * Headless mode with "cypress run"
   *    - runs EACH spec separately, so we cannot reset the coverage
   *      or we will lose the coverage from previous specs.
   */
  resetCoverage({ isInteractive }) {
    if (isInteractive) {
      debug('reset code coverage in interactive mode')
      const coverageMap = istanbul.createCoverageMap({})
      saveCoverage(coverageMap)
      //rmdirSync(join(nycReportOptions.tempDir, 'specific'), { recursive: true })
      ///rmdirSync(join(nycReportOptions.reportDir, 'specific'), { recursive: true })
    }
    /*
        Else:
          in headless mode, assume the coverage file was deleted
          before the `cypress run` command was called
          example: rm -rf .nyc_output || true
      */

    return null
  },

  /**
   * Combines coverage information from single test
   * with previously collected coverage.
   *
   * @param {string} sentCoverage Stringified coverage object sent by the test runner
   * @returns {null} Nothing is returned from this task
   */
  combineCoverage(sentCoverage) {
    try {
      const {coverage, testName} = JSON.parse(sentCoverage)
      debug('parsed sent coverage')
  
      fixSourcePaths(coverage)
  
      const handleCoverage = (fileName) => {
  
        const fullPath = join(nycReportOptions.tempDir, fileName)
  
  
        const previousCoverage = existsSync(fullPath)
          ? JSON.parse(readFileSync(fullPath, 'utf8'))
          : {}
  
        // previous code coverage object might have placeholder entries
        // for files that we have not seen yet,
        // but the user expects to include in the coverage report
        // the merge function messes up, so we should remove any placeholder entries
        // and re-insert them again when creating the report
        removePlaceholders(previousCoverage)
  
        const coverageMap = istanbul.createCoverageMap(previousCoverage)
        coverageMap.merge(coverage)
        saveCoverage(coverageMap, fileName)
        if (Object.keys(previousCoverage).length === 0) {
          console.log('created to', fullPath)
        } else {
          console.log('merged to', fullPath)
        }
        debug('wrote coverage file %s', fileName)
      }
  
      handleCoverage(globalNycFilename)
      const slug = testName.replace(/[\/]+/g, '--')
      handleCoverage(join('specific', slug, 'out.json'))
  
      return null
    } catch (error) {
      console.log('Error while combining coverage', error)
      return null
    }
  },

  /**
   * Saves coverage information as a JSON file and calls
   * NPM script to generate HTML report
   */
  async coverageReport() {
    if (!existsSync(nycFilename)) {
      console.warn('Cannot find coverage file %s', nycFilename)
      console.warn('Skipping coverage report')
      return null
    }

    showNycInfo(nycFilename)

    const allSourceFilesMissing = checkAllPathsNotFound(nycFilename)
    if (allSourceFilesMissing) {
      tryFindingLocalFiles(nycFilename)
    }

    resolveRelativePaths(nycFilename)

    if (customNycReportScript) {
      debug(
        'saving coverage report using script "%s" from package.json, command: %s',
        DEFAULT_CUSTOM_COVERAGE_SCRIPT_NAME,
        customNycReportScript
      )
      debug('current working directory is %s', process.cwd())
      return execa('npm', ['run', DEFAULT_CUSTOM_COVERAGE_SCRIPT_NAME], {
        stdio: 'inherit'
      })
    }

    if (nycReportOptions.all) {
      debug('nyc needs to report on all included files')
      includeAllFiles(nycFilename, nycReportOptions)
    }

    debug('calling NYC reporter with options %o', nycReportOptions)
    debug('current working directory is %s', process.cwd())
    const NYC = require('nyc')
    const nyc = new NYC(nycReportOptions)

    const returnReportFolder = () => {
      const reportFolder = nycReportOptions['report-dir']
      debug(
        'after reporting, returning the report folder name %s',
        reportFolder
      )

      maybePrintFinalCoverageFiles(reportFolder)

      return reportFolder
    }

    mkdirSync(join(nycReportOptions.tempDir, 'specific'), { recursive: true })
    const tempSpecificFiles = readdirSync(join(nycReportOptions.tempDir, 'specific'))
    const startTime = new Date()

    mkdirSync(join(nycReportOptions.reportDir, 'specific'), { recursive: true })
    console.log('Existing results', readdirSync(join(nycReportOptions.reportDir, 'specific')))
    for(let i = 0; i < tempSpecificFiles.length; i++) {
      const fileName = tempSpecificFiles[i];
      try {
        const writeFile = join(nycReportOptions.reportDir, 'specific', fileName.slice(fileName.lastIndexOf('--') + 2).replace(/\.spec\.[jt]{1}s$/, '') + '.json')

        // write every file only once
        if (existsSync(writeFile)) continue;

        console.log('Processing '+fileName)

        const fullCoverageMap = await nyc.getCoverageMapFromAllCoverageFiles(join(nycReportOptions.tempDir, 'specific', fileName))

        mkdirSync(dirname(writeFile), { recursive: true })
        // only write items that actually have values, and only write those values
        writeFileSync(writeFile, JSON.stringify(Object.values(fullCoverageMap.data).map(data => {
          const mapData = data.data

          const b = {}
          Object.entries(mapData.b).forEach(([index, value]) => {
            if (value.some(i => i > 0)) {
              if (!mapData.branchMap[index].loc || !mapData.branchMap[index].loc.start) {
                console.log('not found ', index, ' in ', mapData.branchMap)
              }
              const lineNr = mapData.branchMap[index].loc.start.line
              if (!b[lineNr]) b[lineNr] = []
              b[lineNr].push(value)
            }
          })
          const s = {}
          Object.entries(mapData.s).forEach(([index, value]) => {
            if (value > 0) {
              if (!mapData.statementMap[index] || !mapData.statementMap[index].start) {
                console.log('not found ', index, ' in ', mapData.statementMap)
              }
              const lineNr = mapData.statementMap[index].start.line
              if (!s[lineNr]) s[lineNr] = []
              s[lineNr].push(value)
            }
          })
          const f = {}
          Object.entries(mapData.f).forEach(([index, value]) => {
            if (value > 0) {
              if (!mapData.fnMap[index].loc || !mapData.fnMap[index].loc.start) {
                console.log('not found ', index, ' in ', mapData.fnMap)
              }
              const lineNr = mapData.fnMap[index].loc.start.line
              if (!f[lineNr]) f[lineNr] = []
              f[lineNr].push(value)
            }
          })

          if (Object.keys(b).length > 0 || Object.keys(s).length > 0 || Object.keys(f).length > 0) {
            return {
              path: mapData.path.replace(process.cwd() + '/', ''),
              b,
              s,
              f
            }
          }
          return undefined
        }).filter(i => i)))
        console.log("Written", writeFile)
      } catch(error) {
        console.error("Error generating report for " + fileName)
      }
    }
    console.log("processed individual files in ", new Date().getTime() - startTime.getTime(), 'ms')

    return nyc.report().then(returnReportFolder)
  }
}

/**
 * Registers code coverage collection and reporting tasks.
 * Sets an environment variable to tell the browser code that it can
 * send the coverage.
 * @example
  ```
    // your plugins file
    module.exports = (on, config) => {
      require('cypress/code-coverage/task')(on, config)
      // IMPORTANT to return the config object
      // with the any changed environment variables
      return config
    }
  ```
*/
function registerCodeCoverageTasks(on, config) {
  on('task', tasks)

  // set a variable to let the hooks running in the browser
  // know that they can send coverage commands
  config.env.codeCoverageTasksRegistered = true

  return config
}

module.exports = registerCodeCoverageTasks
