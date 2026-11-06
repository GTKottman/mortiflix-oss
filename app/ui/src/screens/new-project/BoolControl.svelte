<!-- A yes / no setting as a checkbox with its sentence. -->
<script lang="ts">
  interface Props {
    label: string;
    /** A few words that must stay on one line (e.g. "Decide later"). */
    short?: boolean;
    checked: boolean;
    onchange: (checked: boolean) => void;
  }

  let { label, short = false, checked, onchange }: Props = $props();
</script>

<label class="bool" class:short>
  <input type="checkbox" {checked} onchange={(event) => onchange(event.currentTarget.checked)} />
  <span>{label}</span>
</label>

<style>
  .bool {
    display: flex;
    align-items: center;
    gap: var(--s-12);
    font-size: var(--t14);
    cursor: pointer;
  }
  .short {
    flex-shrink: 0;
    white-space: nowrap;
  }
  input {
    flex-shrink: 0;
    width: var(--check-size);
    height: var(--check-size);
    accent-color: var(--text);
  }
</style>
