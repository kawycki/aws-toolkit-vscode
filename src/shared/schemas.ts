/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import globals from './extensionGlobals'
import { activateYamlExtension, YamlExtension } from './extensions/yaml'
import * as pathutil from '../shared/utilities/pathUtils'
import { getLogger } from './logger'
import { FileResourceFetcher } from './resourcefetcher/fileResourceFetcher'
import { getFromUrl, getPropertyFromJsonUrl, HttpResourceFetcher } from './resourcefetcher/httpResourceFetcher'
import { Settings } from './settings'
import { once } from './utilities/functionUtils'
import { Any, ArrayConstructor } from './utilities/typeConstructors'
import { AWS_SCHEME } from './constants'
import { writeFile } from 'fs-extra'
import { SystemUtilities } from './systemUtilities'
import { normalizeVSCodeUri } from './utilities/vsCodeUtils'
import { CloudFormation } from './cloudformation/cloudformation'
import { getStringHash } from './utilities/textUtilities'

const goformationManifestURL = 'https://api.github.com/repos/awslabs/goformation/releases/latest'
const schemaPrefix = `${AWS_SCHEME}://`
const buildspecHostedFilesPath = '/CodeBuild/buildspec/buildspec-standalone.schema.json'
export const buildspecCloudfrontURL = 'https://d3rrggjwfhwld2.cloudfront.net' + buildspecHostedFilesPath
export const buildspecS3FallbackURL = 'https://aws-vs-toolkit.s3.amazonaws.com' + buildspecHostedFilesPath

export type Schemas = { [key: string]: vscode.Uri }
export type SchemaType = 'yaml' | 'json'

export interface SchemaMapping {
    uri: vscode.Uri
    type: SchemaType
    owner?: string
    schema?: string | vscode.Uri
}

export interface SchemaHandler {
    /** Adds or removes a schema mapping to the given `schemas` collection. */
    handleUpdate(mapping: SchemaMapping, schemas: Schemas): Promise<void>
    /** Returns true if the given file path is handled by this `SchemaHandler`. */
    isMapped(f: vscode.Uri | string): boolean
}

export const cfnSchemaUri = (path: vscode.Uri) => vscode.Uri.joinPath(path, 'cloudformation.schema.json')
export const samSchemaUri = (path: vscode.Uri) => vscode.Uri.joinPath(path, 'sam.schema.json')
export const buildSpecSchemaUri = (path: vscode.Uri) => vscode.Uri.joinPath(path, 'buildspec.schema.json')

/**
 * Processes the update of schema mappings for files in the workspace
 */
export class SchemaService {
    private static readonly DEFAULT_UPDATE_PERIOD_MILLIS = 1000

    private updatePeriod: number
    private timer?: NodeJS.Timer

    private updateQueue: SchemaMapping[] = []
    private schemas?: Schemas
    private handlers: Map<SchemaType, SchemaHandler>
    private owned: Map<vscode.Uri, SchemaMapping>

    public constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        opts?: {
            /** Assigned in start(). */
            schemas?: Schemas
            updatePeriod?: number
            handlers?: Map<SchemaType, SchemaHandler>
        }
    ) {
        this.updatePeriod = opts?.updatePeriod ?? SchemaService.DEFAULT_UPDATE_PERIOD_MILLIS
        this.schemas = opts?.schemas
        this.handlers =
            opts?.handlers ??
            new Map<SchemaType, SchemaHandler>([
                ['json', new JsonSchemaHandler()],
                ['yaml', new YamlSchemaHandler()],
            ])
        this.owned = new Map()
    }

    public isMapped(uri: vscode.Uri): boolean {
        for (const h of this.handlers.values()) {
            if (h.isMapped(uri)) {
                return true
            }
        }
        return false
    }

    public async start(): Promise<void> {
        getDefaultSchemas(this.extensionContext).then(schemas => (this.schemas = schemas))
        await this.startTimer()
    }

    /**
     * Registers a schema mapping in the schema service. If the incoming mapping has an owner, then the mapping will be considered "owned".
     * If the URI is owned (in the owners map), the update will only be processed if the incoming mapping owner is the same as the owned user OR
     * the type of the schema changed
     *
     * @param mapping
     * @param flush Flush immediately instead of waiting for timer.
     */
    public registerMapping(mapping: SchemaMapping, flush?: boolean): void {
        // The owner is undefined and needs to be set
        const isOwnerUndefined =
            !this.owned.has(mapping.uri) && mapping.owner !== undefined && mapping.schema !== undefined

        // The owner and the incoming owner are defined but the schema changed
        const isSchemaChanged =
            this.owned.has(mapping.uri) &&
            mapping.owner !== undefined &&
            this.owned.get(mapping.uri)?.schema !== mapping.schema

        if (isOwnerUndefined || isSchemaChanged) {
            this.owned.set(mapping.uri, mapping)
        }

        if (mapping.owner === this.owned.get(mapping.uri)?.owner) {
            this.updateQueue.push(mapping)
            if (flush === true) {
                this.processUpdates()
            }
        }
    }

    public async processUpdates(): Promise<void> {
        if (this.updateQueue.length === 0 || !this.schemas) {
            return
        }

        const batch = this.updateQueue.splice(0, this.updateQueue.length)
        for (const mapping of batch) {
            const { type, schema, uri } = mapping
            const handler = this.handlers.get(type)
            if (!handler) {
                throw new Error(`no registered handler for type ${type}`)
            }
            getLogger().debug(
                'schema service: handle %s mapping: %s -> %s',
                type,
                schema?.toString() ?? '[removed]',
                uri
            )
            await handler.handleUpdate(mapping, this.schemas)
        }
    }

    // TODO: abstract into a common abstraction for background pollers
    private async startTimer(): Promise<void> {
        this.timer = globals.clock.setTimeout(
            // this is async so that we don't have pseudo-concurrent invocations of the callback
            async () => {
                await this.processUpdates()
                this.timer?.refresh()
            },
            this.updatePeriod
        )
    }
}

/**
 * Loads default JSON schemas for CFN and SAM templates.
 * Checks manifest and downloads new schemas if the manifest version has been bumped.
 * Uses local, predownloaded version if up-to-date or network call fails
 * If the user has not previously used the toolkit and cannot pull the manifest, does not provide template autocomplete.
 * @param extensionContext VSCode extension context
 */
export async function getDefaultSchemas(extensionContext: vscode.ExtensionContext): Promise<Schemas | undefined> {
    const cfnSchemaLocation = cfnSchemaUri(extensionContext.globalStorageUri)
    const samSchemaLocation = samSchemaUri(extensionContext.globalStorageUri)
    const buildSpecSchemaLocation = buildSpecSchemaUri(extensionContext.globalStorageUri)

    const goformationSchemaVersion = await getPropertyFromJsonUrl(goformationManifestURL, 'tag_name')
    const schemas: Schemas = {}

    try {
        await updateSchemaFromRemote({
            destination: cfnSchemaLocation,
            version: goformationSchemaVersion,
            url: `https://raw.githubusercontent.com/awslabs/goformation/${goformationSchemaVersion}/schema/cloudformation.schema.json`,
            cacheKey: 'cfnSchemaVersion',
            extensionContext,
            title: schemaPrefix + 'cloudformation.schema.json',
        })
        schemas['cfn'] = cfnSchemaLocation
    } catch (e) {
        getLogger().verbose('Could not download cfn schema: %s', (e as Error).message)
    }

    try {
        await updateSchemaFromRemote({
            destination: samSchemaLocation,
            version: goformationSchemaVersion,
            url: `https://raw.githubusercontent.com/awslabs/goformation/${goformationSchemaVersion}/schema/sam.schema.json`,
            cacheKey: 'samSchemaVersion',
            extensionContext,
            title: schemaPrefix + 'sam.schema.json',
        })
        schemas['sam'] = samSchemaLocation
    } catch (e) {
        getLogger().verbose('Could not download sam schema: %s', (e as Error).message)
    }

    try {
        try {
            const contents = await getFromUrl(buildspecCloudfrontURL)
            const buildspecSchemaVersion = contents ? getStringHash(contents) : undefined
            await updateSchemaFromRemote({
                destination: buildSpecSchemaLocation,
                version: buildspecSchemaVersion,
                url: buildspecCloudfrontURL,
                cacheKey: 'buildSpecSchemaVersion',
                extensionContext,
                title: schemaPrefix + 'buildspec.schema.json',
            })
            schemas['buildspec'] = buildSpecSchemaLocation
        } catch (e) {
            getLogger().verbose(
                'Could not download buildspec schema from CloudFront: %s. Attempting to download buildspec schema from S3',
                (e as Error).message
            )
            const contents = await getFromUrl(buildspecS3FallbackURL)
            const buildspecSchemaVersion = contents ? getStringHash(contents) : undefined
            await updateSchemaFromRemote({
                destination: buildSpecSchemaLocation,
                version: buildspecSchemaVersion,
                url: buildspecS3FallbackURL,
                cacheKey: 'buildSpecSchemaVersion',
                extensionContext,
                title: schemaPrefix + 'buildspec.schema.json',
            })
            schemas['buildspec'] = buildSpecSchemaLocation
        }
    } catch (e) {
        getLogger().verbose('Could not download buildspec schema: %s', (e as Error).message)
    }

    return schemas
}

/**
 * Pulls a remote version of file if the local version doesn't match the manifest version (does not check semver increases) or doesn't exist
 * Pulls local version of file if it does. Uses remote as baskup in case local doesn't exist
 * @param params.filepath Path to local file
 * @param params.version Remote version
 * @param params.url Url to fetch from
 * @param params.cacheKey Cache key to check version against
 * @param params.extensionContext VSCode extension context
 */
export async function updateSchemaFromRemote(params: {
    destination: vscode.Uri
    version?: string
    url: string
    cacheKey: string
    extensionContext: vscode.ExtensionContext
    title: string
}): Promise<void> {
    const cachedVersion = params.extensionContext.globalState.get<string>(params.cacheKey)
    const outdated = params.version && params.version !== cachedVersion

    // Check that the cached file actually can be fetched. Else we might
    // never update the cache.
    const fileFetcher = new FileResourceFetcher(params.destination.fsPath)
    const cachedContent = await fileFetcher.get()

    if (!outdated && cachedContent) {
        return
    }

    try {
        const httpFetcher = new HttpResourceFetcher(params.url, { showUrl: true })
        const content = await httpFetcher.get()

        if (!content) {
            throw new Error(`failed to resolve schema: ${params.destination}`)
        }

        const parsedFile = { ...JSON.parse(content), title: params.title }
        const dir = vscode.Uri.joinPath(params.destination, '..')
        await SystemUtilities.createDirectory(dir)
        await writeFile(params.destination.fsPath, JSON.stringify(parsedFile))
        await params.extensionContext.globalState.update(params.cacheKey, params.version).then(undefined, err => {
            getLogger().warn(`schemas: failed to update cache key for "${params.title}": ${err?.message}`)
        })
    } catch (err) {
        if (cachedContent) {
            getLogger().warn(
                `schemas: failed to fetch the latest version for "${params.title}": ${
                    (err as Error).message
                }. Using cached schema instead.`
            )
        } else {
            throw err
        }
    }
}

/**
 * Adds custom tags to the YAML extension's settings in order to hide error
 * notifications for SAM/CFN intrinsic functions if a user has the YAML extension.
 *
 * Lifted near-verbatim from the cfn-lint VSCode extension.
 * https://github.com/aws-cloudformation/cfn-lint-visual-studio-code/blob/629de0bac4f36cfc6534e409a6f6766a2240992f/client/src/extension.ts#L56
 */
async function addCustomTags(config = Settings.instance): Promise<void> {
    const settingName = 'yaml.customTags'

    try {
        const currentTags = config.get(settingName, ArrayConstructor(Any), [])
        const missingTags = CloudFormation.cloudFormationTags.filter(item => !currentTags.includes(item))

        if (missingTags.length > 0) {
            const updateTags = currentTags.concat(missingTags)

            await config.update(settingName, updateTags)
        }
    } catch (error) {
        getLogger().error('schemas: failed to update setting "%s": %O', settingName, error)
    }
}

/**
 * Registers YAML schema mappings with the Red Hat YAML extension
 */
export class YamlSchemaHandler implements SchemaHandler {
    public constructor(private yamlExtension?: YamlExtension) {}

    isMapped(file: string | vscode.Uri): boolean {
        if (!this.yamlExtension) {
            return false
        }
        const uri = typeof file === 'string' ? vscode.Uri.file(file) : file
        const exists = !!this.yamlExtension?.getSchema(uri)
        return exists
    }

    async handleUpdate(mapping: SchemaMapping, schemas: Schemas): Promise<void> {
        if (!this.yamlExtension) {
            const ext = await activateYamlExtension()
            if (!ext) {
                return
            }
            await addCustomTags()
            this.yamlExtension = ext
        }

        if (mapping.schema) {
            const schema = resolveSchema(mapping.schema, schemas)
            if (!schema) {
                getLogger().debug(
                    `Could not assign schema ${mapping.schema} to ${mapping.uri}. Unable to find schema ${mapping.schema} locally`
                )
                return
            }
            this.yamlExtension.assignSchema(mapping.uri, schema)
        } else {
            this.yamlExtension.removeSchema(mapping.uri)
        }
    }
}

/**
 * Registers JSON schema mappings with the built-in VSCode JSON schema language server
 */
export class JsonSchemaHandler implements SchemaHandler {
    private readonly clean = once(() => this.cleanResourceMappings())

    public constructor(private readonly config = Settings.instance) {}

    public isMapped(file: string | vscode.Uri): boolean {
        const setting = this.getSettingBy({ file: file })
        return !!setting
    }

    /**
     * Gets a json schema setting by filtering on schema path and/or file path.
     * @param args.schemaPath Path to the schema file
     * @param args.file Path to the file being edited by the user
     */
    private getSettingBy(args: {
        schemaPath?: string | vscode.Uri
        file?: string | vscode.Uri
    }): JSONSchemaSettings | undefined {
        const path = typeof args.file === 'string' ? args.file : args.file?.fsPath
        const schm = typeof args.schemaPath === 'string' ? args.schemaPath : args.schemaPath?.fsPath
        const settings = this.getJsonSettings()
        const setting = settings.find(schema => {
            const schmMatch = schm && schema.url && pathutil.normalize(schema.url) === pathutil.normalize(schm)
            const fileMatch = path && schema.fileMatch && schema.fileMatch.includes(path)
            return (!path || fileMatch) && (!schm || schmMatch)
        })
        return setting
    }

    async handleUpdate(mapping: SchemaMapping, schemas: Schemas): Promise<void> {
        await this.clean()

        let settings = this.getJsonSettings()

        const path = normalizeVSCodeUri(mapping.uri)
        if (mapping.schema) {
            const schema = resolveSchema(mapping.schema, schemas)
            if (!schema) {
                getLogger().debug(
                    `Could not assign schema ${mapping.schema} to ${mapping.uri}. Unable to find schema ${mapping.schema} locally`
                )
                return
            }
            const schemaUri = schema.toString()
            const existing = this.getSettingBy({ schemaPath: schemaUri })

            if (existing) {
                if (!existing.fileMatch) {
                    getLogger().debug(`JsonSchemaHandler: skipped setting schema '${schemaUri}'`)
                } else {
                    existing.fileMatch.push(path)
                }
            } else {
                settings.push({
                    fileMatch: [path],
                    url: schemaUri,
                })
            }
        } else {
            settings = filterJsonSettings(settings, file => file !== path)
        }

        await this.config.update('json.schemas', settings)
    }

    /**
     * Attempts to find and remove orphaned resource mappings for AWS Resource documents
     */
    private async cleanResourceMappings(): Promise<void> {
        getLogger().debug(`JsonSchemaHandler: cleaning stale schemas`)

        // In the unlikely scenario of an error, we don't want to bubble it up
        try {
            const settings = filterJsonSettings(this.getJsonSettings(), file => !file.endsWith('.awsResource.json'))
            await this.config.update('json.schemas', settings)
        } catch (error) {
            getLogger().warn(`JsonSchemaHandler: failed to clean stale schemas: ${error}`)
        }
    }

    private getJsonSettings(): JSONSchemaSettings[] {
        return this.config.get('json.schemas', ArrayConstructor(Object), [])
    }
}

function resolveSchema(schema: string | vscode.Uri, schemas: Schemas): vscode.Uri | undefined {
    if (schema instanceof vscode.Uri) {
        return schema
    }
    return schemas[schema]
}

function filterJsonSettings(settings: JSONSchemaSettings[], predicate: (fileName: string) => boolean) {
    return settings.filter(schema => {
        schema.fileMatch = schema.fileMatch?.filter(file => predicate(file))

        // Assumption: `fileMatch` was not empty beforehand
        return schema.fileMatch === undefined || schema.fileMatch.length > 0
    })
}

export interface JSONSchemaSettings {
    fileMatch?: string[]
    url?: string
    schema?: any
}
