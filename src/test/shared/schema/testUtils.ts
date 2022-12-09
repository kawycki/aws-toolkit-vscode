/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import got from 'got'
import * as path from 'path'
import * as vscode from 'vscode'
import { writeFile } from 'fs-extra'
import { GitExtension } from '../../../shared/extensions/git'
import { cfnSchemaUri, samSchemaUri, buildSpecSchemaUri, buildspecCloudfrontURL } from '../../../shared/schemas'
import { getLogger } from '../../../shared/logger'

export type JSONValue = string | boolean | number | null | JSONValue[] | JSONObject

export interface JSONObject {
    [key: string]: JSONValue
}

export interface TestSchemas {
    samSchema: JSONObject
    cfnSchema: JSONObject
    buildSpecSchema: JSONObject
}

async function downloadCITestSchemas() {
    const fetchUrl = 'https://github.com/awslabs/goformation'
    const repo = await GitExtension.instance.listAllRemoteFiles({
        fetchUrl,
    })

    const samFilePath = path.join('schema', 'sam.schema.json')
    const samSchemaFile = await repo.files.find(f => f.name === samFilePath)?.read()
    if (!samSchemaFile) {
        throw new Error(`Unable to find the sam schema file in path ${samFilePath} in repository ${fetchUrl}`)
    }

    const cfnFilePath = path.join('schema', 'cloudformation.schema.json')
    const cfnSchemaFile = await repo.files.find(f => f.name === cfnFilePath)?.read()
    if (!cfnSchemaFile) {
        throw new Error(
            `Unable to find the cloudformation schema file in path ${cfnFilePath} in repository ${fetchUrl}`
        )
    }

    repo.dispose()

    const buildSpecSchemaFile = await got.get(buildspecCloudfrontURL).text()

    return {
        cfnSchemaFile,
        samSchemaFile,
        buildSpecSchemaFile,
    }
}

export async function writeTestSchemas(storageLocation: vscode.Uri): Promise<void> {
    getLogger().info('Schema storage location is currently: ' + storageLocation.fsPath)
    const files = await downloadCITestSchemas()
    await writeFile(cfnSchemaUri(storageLocation).fsPath, files.cfnSchemaFile)
    getLogger().info(`Wrote cfn schema to ${cfnSchemaUri(storageLocation).fsPath}`)
    await writeFile(samSchemaUri(storageLocation).fsPath, files.samSchemaFile)
    getLogger().info(`Wrote sam schema to ${samSchemaUri(storageLocation).fsPath}`)
    await writeFile(buildSpecSchemaUri(storageLocation).fsPath, files.buildSpecSchemaFile)
    getLogger().info(`Wrote buildspec schema to ${buildSpecSchemaUri(storageLocation).fsPath}`)
}

export async function getCITestSchemas(): Promise<TestSchemas> {
    const schemas = await downloadCITestSchemas()
    const samSchema = JSON.parse(schemas.samSchemaFile)
    const cfnSchema = JSON.parse(schemas.cfnSchemaFile)
    const buildSpecSchema = JSON.parse(schemas.buildSpecSchemaFile)
    return {
        samSchema,
        cfnSchema,
        buildSpecSchema,
    }
}

/**
 * Assert whether or not name exists under definitionName in the JSON schema
 * @param schema The JSON schema
 * @param definitionName The name of the definition to use
 * @param name The name of the property to look for
 */
export function assertDefinitionProperty(schema: JSONObject, definitionName: string, name: string): void | never {
    const definitionProperties = unmarshal(schema, 'definitions', definitionName, 'properties')
    assertProperty(definitionProperties, name)
}

/**
 * Assert whether name exists at an arbitary location in the JSON schema
 * @param arbitrarySchemaLocation An arbitary location in the JSON schema
 * @param name The name of the property to look for
 */
export function assertProperty(arbitrarySchemaLocation: JSONObject, name: string): void | never {
    assert.ok(name in arbitrarySchemaLocation, `Property ${name} was not found in the "Properties" object`)
}

/**
 * Assert whether a reference exists at definitionLocation to referenceName in the JSON Schema
 * @param definitionLocation A location in the JSON schema
 * @param referenceName A name of a reference to look for
 */
export function assertRef(definitionLocation: JSONObject, referenceName: string): void | never {
    const definitionRef = definitionLocation['$ref']
    if (definitionRef !== `#/definitions/AWS::Serverless::${referenceName}`) {
        assert.fail(`The reference for ${definitionRef} did not point to ${referenceName}`)
    }
}

/**
 * Assert that definitionName is in the JSON schemas definitions
 * @param schema The JSON schema to use
 * @param definitionName The name of the definition to check
 */
export function assertDefinition(schema: JSONObject, definitionName: string): void | never {
    if (!(definitionName in (schema['definitions'] as JSONObject))) {
        assert.fail(`Definition for ${definitionName} not found`)
    }
}

/**
 * Traverse through the initial JSON object, visiting all of the properties.
 * Only suitable for accessing JSON objects.
 * @param initialObject the object you want to start the traversal at
 * @param properties the properties you want to visit and traverse into
 * @returns The location in initialObject after visiting all of properties
 */
export function unmarshal(initialObject: JSONObject, ...properties: string[]) {
    let processedObject = initialObject
    for (const propertyName of properties) {
        processedObject = processedObject[propertyName] as JSONObject
    }
    return processedObject
}
