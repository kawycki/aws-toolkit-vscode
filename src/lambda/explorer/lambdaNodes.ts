/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import { Lambda } from 'aws-sdk'
import * as vscode from 'vscode'
import { DefaultLambdaClient } from '../../shared/clients/lambdaClient'

import { AWSTreeNodeBase } from '../../shared/treeview/nodes/awsTreeNodeBase'
import { PlaceholderNode } from '../../shared/treeview/nodes/placeholderNode'
import { makeChildrenNodes } from '../../shared/treeview/utils'
import { toArrayAsync, toMap, updateInPlace } from '../../shared/utilities/collectionUtils'
import { listLambdaFunctions } from '../utils'
import { LambdaFunctionNode } from './lambdaFunctionNode'

/**
 * An AWS Explorer node representing the Lambda Service.
 * Contains Lambda Functions for a specific region as child nodes.
 */
export class LambdaNode extends AWSTreeNodeBase {
    private readonly functionNodes: Map<string, LambdaFunctionNode>

    public constructor(
        public readonly regionCode: string,
        private readonly client = new DefaultLambdaClient(regionCode)
    ) {
        super('Lambda', vscode.TreeItemCollapsibleState.Collapsed)
        this.functionNodes = new Map<string, LambdaFunctionNode>()
        this.contextValue = 'awsLambdaNode'
    }

    public async getChildren(): Promise<AWSTreeNodeBase[]> {
        return await makeChildrenNodes({
            getChildNodes: async () => {
                await this.updateChildren()

                return [...this.functionNodes.values()]
            },
            getNoChildrenPlaceholderNode: async () =>
                new PlaceholderNode(this, localize('AWS.explorerNode.lambda.noFunctions', '[No Functions found]')),
            sort: (nodeA, nodeB) => nodeA.functionName.localeCompare(nodeB.functionName),
        })
    }

    public async updateChildren(): Promise<void> {
        const functions: Map<string, Lambda.FunctionConfiguration> = toMap(
            await toArrayAsync(listLambdaFunctions(this.client)),
            configuration => configuration.FunctionName
        )

        updateInPlace(
            this.functionNodes,
            functions.keys(),
            key => this.functionNodes.get(key)!.update(functions.get(key)!),
            key => new LambdaFunctionNode(this, this.regionCode, functions.get(key)!)
        )
    }
}
