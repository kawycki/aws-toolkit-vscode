<template>
    <div class="auth-form container-background border-common" id="builder-id-form">
        <div>
            <FormTitle :isConnected="isConnected">AWS Builder ID</FormTitle>

            <div v-if="stage === 'START'">
                <div class="form-section">
                    <div class="sub-text-color">
                        {{ getDescription() }}
                        <a :href="signUpUrl" v-on:click="emitUiClick('auth_learnMoreBuilderId')">Learn more.</a>
                    </div>
                </div>

                <div class="form-section">
                    <button v-on:click="startSignIn()">{{ submitButtonText }}</button>
                    <div class="small-description error-text">{{ error }}</div>
                </div>
            </div>

            <div v-if="stage === 'WAITING_ON_USER'">
                <div class="form-section">
                    <div>Follow instructions...</div>
                </div>
            </div>

            <div v-if="stage === 'CONNECTED'">
                <div class="form-section">
                    <div v-on:click="signout()" class="text-link-color" style="cursor: pointer">Sign out</div>
                </div>

                <div class="form-section">
                    <button v-on:click="showNodeInView()">Open {{ name }} in Toolkit</button>
                </div>
            </div>
        </div>
    </div>
</template>
<script lang="ts">
import { PropType, defineComponent } from 'vue'
import BaseAuthForm, { ConnectionUpdateCause } from './baseAuth.vue'
import FormTitle from './formTitle.vue'
import { AuthUiClick, AuthWebview } from '../show'
import { AuthFormId } from './types'
import { WebviewClientFactory } from '../../../../webviews/client'
import { AuthError } from '../types'
import { FeatureId } from '../../../../shared/telemetry/telemetry.gen'
import { AuthForm } from './shared.vue'

const client = WebviewClientFactory.create<AuthWebview>()

/** Where the user is currently in the builder id setup process */
type BuilderIdStage = 'START' | 'WAITING_ON_USER' | 'CONNECTED'

export default defineComponent({
    name: 'CredentialsForm',
    extends: BaseAuthForm,
    components: { FormTitle },
    props: {
        state: {
            type: Object as PropType<BaseBuilderIdState>,
            required: true,
        },
    },
    data() {
        return {
            stage: 'START' as BuilderIdStage,
            isConnected: false,
            builderIdCode: '',
            name: this.state.name,
            error: '' as string,
            signUpUrl: '' as string,
            submitButtonText: '' as string,
        }
    },
    async created() {
        this.signUpUrl = this.getSignUpUrl()
        await this.update('created')
    },
    methods: {
        async startSignIn() {
            this.stage = 'WAITING_ON_USER'
            client.startAuthFormInteraction(this.state.featureType, 'awsId')
            const authError = await this.state.startBuilderIdSetup()

            if (authError) {
                this.error = authError.text
                this.stage = await this.state.stage()

                client.failedAuthAttempt({
                    authType: 'awsId',
                    featureType: this.state.featureType,
                    reason: authError.id,
                })
            } else {
                client.successfulAuthAttempt({
                    featureType: this.state.featureType,
                    authType: 'awsId',
                })
                await this.update('signIn')
            }
        },
        async update(cause?: ConnectionUpdateCause) {
            await this.updateSubmitButtonText()
            this.stage = await this.state.stage()
            this.isConnected = await this.state.isAuthConnected()
            this.emitAuthConnectionUpdated({ id: this.state.id, isConnected: this.isConnected, cause })
        },
        async signout() {
            await this.state.signout()
            client.emitUiClick(this.state.uiClickSignout)
            this.update('signOut')
        },
        showNodeInView() {
            this.state.showNodeInView()
            client.emitUiClick(this.state.uiClickOpenId)
        },
        getSignUpUrl() {
            return this.state.getSignUpUrl()
        },
        getDescription() {
            return this.state.getDescription()
        },
        async updateSubmitButtonText() {
            if (!(await isBuilderIdConnected())) {
                this.submitButtonText = 'Sign up or Sign in'
            } else {
                this.submitButtonText = `Connect AWS Builder ID with ${this.state.name}`
            }
        },
    },
})

/**
 * Manages the state of Builder ID.
 */
abstract class BaseBuilderIdState implements AuthForm {
    protected _stage: BuilderIdStage = 'START'

    abstract get name(): string
    abstract get id(): AuthFormId
    abstract get uiClickOpenId(): AuthUiClick
    abstract get uiClickSignout(): AuthUiClick
    abstract get featureType(): FeatureId
    protected abstract _startBuilderIdSetup(): Promise<AuthError | undefined>
    abstract isAuthConnected(): Promise<boolean>
    abstract showNodeInView(): Promise<void>

    protected constructor() {}

    async startBuilderIdSetup(): Promise<AuthError | undefined> {
        this._stage = 'WAITING_ON_USER'
        return this._startBuilderIdSetup()
    }

    async stage(): Promise<BuilderIdStage> {
        const isAuthConnected = await this.isAuthConnected()
        this._stage = isAuthConnected ? 'CONNECTED' : 'START'
        return this._stage
    }

    async signout(): Promise<void> {
        await client.signoutBuilderId()
    }

    getSignUpUrl(): string {
        return 'https://docs.aws.amazon.com/signin/latest/userguide/sign-in-aws_builder_id.html'
    }

    getDescription(): string {
        return 'With AWS Builder ID, sign in for free without an AWS account.'
    }
}

export class CodeWhispererBuilderIdState extends BaseBuilderIdState {
    override get name(): string {
        return 'CodeWhisperer'
    }

    override get id(): AuthFormId {
        return 'builderIdCodeWhisperer'
    }

    override get uiClickOpenId(): AuthUiClick {
        return 'auth_openCodeWhisperer'
    }

    override get uiClickSignout(): AuthUiClick {
        return 'auth_codewhisperer_signoutBuilderId'
    }

    override get featureType(): FeatureId {
        return 'codewhisperer'
    }

    override isAuthConnected(): Promise<boolean> {
        return client.isCodeWhispererBuilderIdConnected()
    }

    protected override _startBuilderIdSetup(): Promise<AuthError | undefined> {
        return client.startCodeWhispererBuilderIdSetup()
    }

    override showNodeInView(): Promise<void> {
        return client.showCodeWhispererNode()
    }

    override getSignUpUrl(): string {
        return 'https://docs.aws.amazon.com/codewhisperer/latest/userguide/whisper-setup-indv-devs.html'
    }

    static #instance: CodeWhispererBuilderIdState | undefined

    static get instance(): CodeWhispererBuilderIdState {
        return (this.#instance ??= new CodeWhispererBuilderIdState())
    }
}

export class CodeCatalystBuilderIdState extends BaseBuilderIdState {
    override get name(): string {
        return 'CodeCatalyst'
    }

    override get id(): AuthFormId {
        return 'builderIdCodeCatalyst'
    }

    override get uiClickOpenId(): AuthUiClick {
        return 'auth_openCodeCatalyst'
    }

    override get uiClickSignout(): AuthUiClick {
        return 'auth_codecatalyst_signoutBuilderId'
    }

    override get featureType(): FeatureId {
        return 'codecatalyst'
    }

    override isAuthConnected(): Promise<boolean> {
        return client.isCodeCatalystBuilderIdConnected()
    }

    protected override _startBuilderIdSetup(): Promise<AuthError | undefined> {
        return client.startCodeCatalystBuilderIdSetup()
    }

    override showNodeInView(): Promise<void> {
        return client.showCodeCatalystNode()
    }

    static #instance: CodeCatalystBuilderIdState | undefined

    static get instance(): CodeCatalystBuilderIdState {
        return (this.#instance ??= new CodeCatalystBuilderIdState())
    }

    override getDescription(): string {
        return 'You must have an existing CodeCatalyst Space connected to your AWS Builder ID.'
    }

    override getSignUpUrl(): string {
        return 'https://aws.amazon.com/codecatalyst/'
    }
}

/**
 * Returns true if any Builder Id is connected
 */
export async function isBuilderIdConnected(): Promise<boolean> {
    const results = await Promise.all([
        CodeWhispererBuilderIdState.instance.isAuthConnected(),
        CodeCatalystBuilderIdState.instance.isAuthConnected(),
    ])
    return results.some(isConnected => isConnected)
}
</script>
<style>
@import './sharedAuthForms.css';
@import '../shared.css';

#builder-id-form {
    width: 300px;
    height: fit-content;
}
</style>
