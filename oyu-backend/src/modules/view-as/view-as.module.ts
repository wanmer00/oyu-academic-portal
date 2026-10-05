import { Module } from '@nestjs/common';
import { ViewAsController } from './view-as.controller';

@Module({ controllers: [ViewAsController] })
export class ViewAsModule {}