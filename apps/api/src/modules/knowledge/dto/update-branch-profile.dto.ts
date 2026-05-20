import { PartialType } from '@nestjs/mapped-types';
import { CreateBranchProfileDto } from './create-branch-profile.dto';

export class UpdateBranchProfileDto extends PartialType(CreateBranchProfileDto) {}
