import { Module } from '@nestjs/common';
import { MaterialsService } from './materials.service';
import {
  StudentMaterialsController,
  TeacherMaterialsController,
} from './materials.controller';

@Module({
  controllers: [StudentMaterialsController, TeacherMaterialsController],
  providers: [MaterialsService],
  exports: [MaterialsService],
})
export class MaterialsModule {}
