import express, { Request, Response } from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import analytics from '../analytics';
import { getUserInfoFromToken, getUserInfoFromGitHubUsername, doesExceedQuota } from './user';
import { EXPLAIN_SIMPLE, EXPLAIN_WITH_LANGUAGE } from '../prompts/explain';
import { ASK } from '../prompts/ask';
import { EXPLAIN_PARAM, GET_PARAMS, SUMMARIZE_CODE, GET_RETURN } from '../prompts/docstring';
import { TRANSLATE } from '../prompts/translate';
import { COMPLEXITY } from '../prompts/complexity';
import { OPENAI_AUTHORIZATION } from '../constants/connection';
import Fig from '../models/Fig';

const CODEX_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const AVERAGE_CODEX_TOKENS_BUDGET = 180;
const CODEX_TEMPERATURE = 0;

const MAX_CODE_LENGTH = 1500;

const functionRouter = express.Router();

export type FigFunction = 'explain' | 'ask' | 'docstring' | 'complexity' | 'translate';

type LogFunction = {
  id: string;
  email: string;
  figFunction: FigFunction;
  input: string;
  output: string;
  source?: string;
  inputLanguage: string;
  outputLanguage: string;
}

type RequiredArg = {
  value: string | null | undefined;
  errorOnEmpty: string;
}

type ConditionalArg = {
  condition: boolean;
  errorOnFail: string;
}

const logNewFunction = async (figLog: LogFunction) => {
  const newFigLog = new Fig(figLog);
  await newFigLog.save();
}

const throwErrorOnEmpty = (...args: RequiredArg[]) => {
  args.forEach((arg) => {
    if (arg.value == null || arg.value === '') {
      throw arg.errorOnEmpty;
    }
  })
}

const throwErrorOnCondition = (...args: ConditionalArg[]) => {
  args.forEach((arg) => {
    if (arg.condition) {
      throw arg.errorOnFail;
    }
  })
}

functionRouter.post('/v1/explain', async (req: Request, res: Response) => {
  try {
    const { code, inputLanguage, outputLanguage, accessToken, refreshToken, source, githubUsername } = req.body;
    const codeTrimmed = code.trim();

    throwErrorOnEmpty(
      { value: codeTrimmed, errorOnEmpty: 'No code entered' },
      { value: inputLanguage, errorOnEmpty: 'No programming language selected' },
    );
    throwErrorOnCondition(
      { condition: code.length > MAX_CODE_LENGTH, errorOnFail: `Input cannot exceed over ${MAX_CODE_LENGTH} characters` }
    )

    let userInfo, newTokens;
    if (githubUsername) {
      userInfo = await getUserInfoFromGitHubUsername(githubUsername);
    } else {
      ({ userInfo, newTokens } = await getUserInfoFromToken(accessToken, refreshToken));
    }

    const isQuotaExceeded = await doesExceedQuota(userInfo.email);
    if (isQuotaExceeded) {
      throw 'Monthly quota exceeded. Upgrade your plan to continue';
    }

    const isLongerThanOneLine = codeTrimmed.split('\n').length > 1;
    const { prompt, stop, postFormat } = isLongerThanOneLine
      ? EXPLAIN_WITH_LANGUAGE(codeTrimmed, inputLanguage) : EXPLAIN_SIMPLE(codeTrimmed, inputLanguage);

    const codexResponse = await axios.post(CODEX_ENDPOINT, {
      "messages": `[{"role": "user", "content": "${prompt}"}]`,
      'model': "gpt-3.5-turbo-16k-0613",
      temperature: CODEX_TEMPERATURE,
      max_tokens: AVERAGE_CODEX_TOKENS_BUDGET,
      stop,
    }, OPENAI_AUTHORIZATION);

    const firstResponse = codexResponse.data.choices[0].text;
    let output = postFormat(firstResponse);
    const id = uuidv4();

    await logNewFunction({
      id,
      email: userInfo.email as string,
      figFunction: 'explain',
      input: codeTrimmed,
      inputLanguage,
      outputLanguage,
      output,
      source,
    });

    analytics.track({
      userId: userInfo.userId,
      event: 'Explain Function',
      properties: {
        source,
        inputLanguage,
        outputLanguage,
      }
    });

    return res.status(200).send({ id, output, newTokens });
  } catch (error) {
    res.status(400).send({
      returnCode: 400,  // Bad Request
    });
  }
});

export default functionRouter;