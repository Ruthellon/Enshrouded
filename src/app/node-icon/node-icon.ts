import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BUBBLE_RADIUS, gateShape } from '../ksd/node-shapes';
import { typeColor } from '../ksd/sparkworks-types';

/** Small picture of a node type: the gate symbol for logic gates, otherwise a coloured circle. */
@Component({
  selector: 'app-node-icon',
  templateUrl: './node-icon.html',
  styleUrl: './node-icon.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NodeIcon {
  readonly type = input.required<number>();
  readonly size = input(26);

  protected readonly gate = computed(() => gateShape(this.type()));
  protected readonly color = computed(() => typeColor(this.type()));
  protected readonly bubbleRadius = BUBBLE_RADIUS;
}
