import logger from 'wdio-logger'

import ConfigParser from './lib/ConfigParser'
import { getLauncher, initReporters, runServiceHook, initialisePlugin } from './utils'

const log = logger('wdio-cli:Launcher')

class Launcher {
    constructor (configFile, argv) {
        this.configParser = new ConfigParser()
        this.configParser.addConfigFile(configFile)
        this.configParser.merge(argv)

        this.reporters = initReporters(this.configParser.getConfig())
        this.isMultiremote = !Array.isArray(this.configParser.getCapabilities())

        this.argv = argv
        this.configFile = configFile

        this.exitCode = 0
        this.hasTriggeredExitRoutine = false
        this.hasStartedAnyProcess = false
        this.runner = []
        this.schedule = []
        this.rid = []
        this.runnerStarted = 0
        this.runnerFailed = 0
    }

    /**
     * run sequence
     * @return  {Promise} that only gets resolves with either an exitCode or an error
     */
    async run () {
        let config = this.configParser.getConfig()
        let caps = this.configParser.getCapabilities()
        let launcher = getLauncher(config)

        this.reporters.handleEvent('start', {
            isMultiremote: this.isMultiremote,
            capabilities: caps,
            config
        })

        /**
         * run onPrepare hook
         */
        await config.onPrepare(config, caps)
        await runServiceHook(launcher, 'onPrepare', config, caps)

        /**
         * if it is an object run multiremote test
         */
        if (this.isMultiremote) {
            let exitCode = await new Promise((resolve) => {
                this.resolve = resolve
                this.startInstance(this.configParser.getSpecs(), caps, 0)
            })

            /**
             * run onComplete hook for multiremote
             */
            await runServiceHook(launcher, 'onComplete', exitCode, config, caps)
            await config.onComplete(exitCode, config, caps)

            return exitCode
        }

        /**
         * schedule test runs
         */
        let cid = 0
        for (let capabilities of caps) {
            this.schedule.push({
                cid: cid++,
                caps: capabilities,
                specs: this.configParser.getSpecs(capabilities.specs, capabilities.exclude),
                availableInstances: capabilities.maxInstances || config.maxInstancesPerCapability,
                runningInstances: 0,
                seleniumServer: { host: config.host, port: config.port, protocol: config.protocol }
            })
        }

        /**
         * catches ctrl+c event
         */
        process.on('SIGINT', this.exitHandler.bind(this))

        /**
         * make sure the program will not close instantly
         */
        if (process.stdin.isPaused()) {
            process.stdin.resume()
        }

        let exitCode = await new Promise((resolve) => {
            this.resolve = resolve

            /**
             * return immediately if no spec was run
             */
            if (this.runSpecs()) {
                resolve(0)
            }
        })

        /**
         * run onComplete hook
         */
        await runServiceHook(launcher, 'onComplete', exitCode, config, caps)
        await config.onComplete(exitCode, config, caps)

        return exitCode
    }

    /**
     * run multiple single remote tests
     * @return {Boolean} true if all specs have been run and all instances have finished
     */
    runSpecs () {
        let config = this.configParser.getConfig()

        /**
         * stop spawning new processes when CTRL+C was triggered
         */
        if (this.hasTriggeredExitRoutine) {
            return true
        }

        while (this.getNumberOfRunningInstances() < config.maxInstances) {
            let schedulableCaps = this.schedule
                /**
                 * bail if number of errors exceeds allowed
                 */
                .filter(() => {
                    const filter = typeof config.bail !== 'number' || config.bail < 1 ||
                                   config.bail > this.runnerFailed

                    /**
                     * clear number of specs when filter is false
                     */
                    if (!filter) {
                        this.schedule.forEach((t) => { t.specs = [] })
                    }

                    return filter
                })
                /**
                 * make sure complete number of running instances is not higher than general maxInstances number
                 */
                .filter(() => this.getNumberOfRunningInstances() < config.maxInstances)
                /**
                 * make sure the capability has available capacities
                 */
                .filter((a) => a.availableInstances > 0)
                /**
                 * make sure capability has still caps to run
                 */
                .filter((a) => a.specs.length > 0)
                /**
                 * make sure we are running caps with less running instances first
                 */
                .sort((a, b) => a.runningInstances > b.runningInstances)

            /**
             * continue if no capability were schedulable
             */
            if (schedulableCaps.length === 0) {
                break
            }

            this.startInstance(
                [schedulableCaps[0].specs.shift()],
                schedulableCaps[0].caps,
                schedulableCaps[0].cid,
                schedulableCaps[0].seleniumServer
            )
            schedulableCaps[0].availableInstances--
            schedulableCaps[0].runningInstances++
        }

        return this.getNumberOfRunningInstances() === 0 && this.getNumberOfSpecsLeft() === 0
    }

    /**
     * gets number of all running instances
     * @return {number} number of running instances
     */
    getNumberOfRunningInstances () {
        return this.schedule.map((a) => a.runningInstances).reduce((a, b) => a + b)
    }

    /**
     * get number of total specs left to complete whole suites
     * @return {number} specs left to complete suite
     */
    getNumberOfSpecsLeft () {
        return this.schedule.map((a) => a.specs.length).reduce((a, b) => a + b)
    }

    /**
     * Start instance in a child process.
     * @param  {Array} specs  Specs to run
     * @param  {Number} cid  Capabilities ID
     */
    startInstance (spec, caps, cid, server) {
        let config = this.configParser.getConfig()
        cid = this.getRunnerId(cid)
        let processNumber = this.runnerStarted + 1

        // process.debugPort defaults to 5858 and is set even when process
        // is not being debugged.
        let debugArgs = []
        let debugType
        let debugHost = ''
        let debugPort = process.debugPort
        for (let i in process.execArgv) {
            const debugArgs = process.execArgv[i].match('--(debug|inspect)(?:-brk)?(?:=(.*):)?')
            if (debugArgs) {
                let [, type, host] = debugArgs
                if (type) {
                    debugType = type
                }
                if (host) {
                    debugHost = `${host}:`
                }
            }
        }

        if (debugType) {
            debugArgs.push(`--${debugType}=${debugHost}${(debugPort + processNumber)}`)
        }

        // if you would like to add --debug-brk, use a different port, etc...
        let capExecArgs = [
            ...(config.execArgv || []),
            ...(caps.execArgv || [])
        ]

        // The default value for child.fork execArgs is process.execArgs,
        // so continue to use this unless another value is specified in config.
        let defaultArgs = (capExecArgs.length) ? process.execArgv : []

        // If an arg appears multiple times the last occurrence is used
        let execArgv = [ ...defaultArgs, ...debugArgs, ...capExecArgs ]

        // prefer launcher settings in capabilities over general launcher
        const Runner = initialisePlugin(caps.runner || config.runner, 'runner')
        const runner = new Runner({
            cid,
            command: 'run',
            configFile: this.configFile,
            argv: this.argv,
            caps,
            processNumber,
            spec,
            server,
            isMultiremote: this.isMultiremote,
            execArgv
        })

        runner.run()
        this.runner.push(runner)

        runner
            .on('message', this.messageHandler.bind(this, cid))
            .on('exit', this.endHandler.bind(this, cid))

        this.runnerStarted++
    }

    /**
     * generates a runner id
     * @param  {Number} cid capability id (unique identifier for a capability)
     * @return {String}     runner id (combination of cid and test id e.g. 0a, 0b, 1a, 1b ...)
     */
    getRunnerId (cid) {
        if (!this.rid[cid]) {
            this.rid[cid] = 0
        }
        return `${cid}-${this.rid[cid]++}`
    }

    /**
     * emit event from child process to reporter
     * @param  {String} cid
     * @param  {Object} m event object
     */
    messageHandler (cid, m) {
        this.hasStartedAnyProcess = true

        if (!m.cid) {
            m.cid = cid
        }

        if (m.event === 'runner:error') {
            this.reporters.handleEvent('error', m)
        }

        this.reporters.handleEvent(m.event, m)
    }

    /**
     * Close test runner process once all child processes have exited
     * @param  {Number} cid  Capabilities ID
     * @param  {Number} childProcessExitCode  exit code of child process
     */
    endHandler (cid, childProcessExitCode) {
        this.exitCode = this.exitCode || childProcessExitCode
        this.runnerFailed += childProcessExitCode !== 0 ? 1 : 0

        // Update schedule now this process has ended
        if (!this.isMultiremote) {
            // get cid (capability id) from rid (runner id)
            cid = parseInt(cid, 10)

            this.schedule[cid].availableInstances++
            this.schedule[cid].runningInstances--
        }

        if (!this.isMultiremote && !this.runSpecs()) {
            return
        }

        this.reporters.handleEvent('end', {
            sigint: this.hasTriggeredExitRoutine,
            exitCode: this.exitCode,
            isMultiremote: this.isMultiremote,
            capabilities: this.configParser.getCapabilities(),
            config: this.configParser.getConfig()
        })

        if (this.exitCode === 0) {
            return this.resolve(this.exitCode)
        }

        /**
         * finish with exit code 1
         */
        return this.resolve(1)
    }

    /**
     * Make sure all started selenium sessions get closed properly and prevent
     * having dead driver processes. To do so let the runner end its Selenium
     * session first before killing
     */
    exitHandler () {
        if (this.hasTriggeredExitRoutine || !this.hasStartedAnyProcess) {
            log.log('\nKilling process, bye!')

            // When spawned as a subprocess,
            // SIGINT will not be forwarded to childs.
            // Thus for the child to exit cleanly, we must force send SIGINT
            if (!process.stdin.isTTY) {
                this.runner.forEach(r => r.kill('SIGINT'))
            }

            // finish with exit code 1
            return this.resolve(1)
        }

        // When spawned as a subprocess,
        // SIGINT will not be forwarded to childs.
        // Thus for the child to exit cleanly, we must force send SIGINT
        if (!process.stdin.isTTY) {
            this.runner.forEach(r => r.kill('SIGINT'))
        }

        log.log(`

End selenium sessions properly ...
(press ctrl+c again to hard kill the runner)
`)

        this.hasTriggeredExitRoutine = true
    }
}

export default Launcher
