/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { readFileSync } from 'fs-extra'
import { VSCODE_EXTENSION_ID } from '../extensions'
import { getLogger } from '../logger/logger'
import { getIdeProperties, isCloud9 } from '../extensionUtilities'
import { activateExtension } from '../utilities/vsCodeUtils'
import { AWS_SCHEME } from '../constants'
import { activateYAMLLanguageService, configureLanguageService } from './yamlService'

// sourced from https://github.com/redhat-developer/vscode-yaml/blob/3d82d61ea63d3e3a9848fe6b432f8f1f452c1bec/src/schema-extension-api.ts
// removed everything that is not currently being used
interface YamlExtensionApi {
    registerContributor(
        schema: string,
        requestSchema: (resource: string) => string | undefined,
        requestSchemaContent: (uri: string) => string,
        label?: string
    ): boolean
}

function applyScheme(scheme: string, path: vscode.Uri): vscode.Uri {
    return path.with({ scheme })
}

function evaluate(schema: vscode.Uri | (() => vscode.Uri)): vscode.Uri {
    return schema instanceof Function ? schema() : schema
}

export interface YamlExtension {
    assignSchema(path: string, registry: string | undefined, schema: vscode.Uri | (() => vscode.Uri)): void
    removeSchema(path: string, registry: string | undefined): void
    getSchema(path: string): string | undefined
}

function registerSchema(
    path: string,
    registry: string | undefined,
    schema: vscode.Uri | (() => vscode.Uri),
    schemaMap: Map<string, Map<string, vscode.Uri>>
) {
    if (!registry) {
        return
    }
    const schemas = schemaMap.get(path)
    if (!schemas) {
        schemaMap.set(path, new Map())
    }
    schemaMap.set(path, schemaMap.get(path)!.set(registry, applyScheme(AWS_SCHEME, evaluate(schema))))
}

function deRegisterSchema(path: string, registry: string | undefined, schemaMap: Map<string, Map<string, vscode.Uri>>) {
    if (!registry) {
        return
    }
    const schemas = schemaMap.get(path)
    if (!schemas) {
        return
    }
    schemas.delete(registry)
}

function getSchemas(path: string, schemaMap: Map<string, Map<string, vscode.Uri>>): string | undefined {
    const schema = schemaMap.get(path)
    if (!schema) {
        return undefined
    }
    const possibleSchemas = Array.from(schema.values()).filter(schema => schema !== undefined)
    if (possibleSchemas.length > 0) {
        return possibleSchemas[0].toString()
    }
    return undefined
}

export async function activateYamlExtension(): Promise<YamlExtension | undefined> {
    const schemaMap = new Map<string, Map<string, vscode.Uri>>()

    if (isCloud9()) {
        // Until Cloud 9 supports VSCode-YAML out of the box, start the yaml-language-service
        // inside of the toolkit so that users can still have cfn/sam support
        const languageService = await activateYAMLLanguageService()
        return {
            assignSchema: (path, registry, schema) => {
                registerSchema(path, registry, schema, schemaMap)
                configureLanguageService(languageService, schemaMap)
            },
            removeSchema: (path, registry) => {
                deRegisterSchema(path, registry, schemaMap)
                configureLanguageService(languageService, schemaMap)
            },
            getSchema: path => getSchemas(path, schemaMap),
        }
    }

    const yamlExt = await activateExtension<YamlExtensionApi>(VSCODE_EXTENSION_ID.yaml)
    if (!yamlExt) {
        return undefined
    }
    yamlExt.exports.registerContributor(
        AWS_SCHEME,
        resource => {
            return getSchemas(resource, schemaMap)
        },
        uri => {
            try {
                return readFileSync(vscode.Uri.parse(uri).fsPath).toString()
            } catch (e) {
                getLogger().error(`YAML Extension: failed to read schema URI "${uri}": ${e}`)
                throw new Error(`${getIdeProperties().company} Toolkit could not parse JSON schema URI: ${uri}`)
            }
        }
    )
    return {
        assignSchema: (path, registry, schema) => {
            registerSchema(path, registry, schema, schemaMap)
        },
        removeSchema: (path, registry) => deRegisterSchema(path, registry, schemaMap),
        getSchema: path => getSchemas(path, schemaMap),
    }
}
